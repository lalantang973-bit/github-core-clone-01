// Git smart-HTTP implementation: pkt-line codec, packfile read/write, protocol v2
// upload-pack (advertise / ls-refs / fetch) and v0 receive-pack (advertise / push).
//
// The object store lives in store.ts (repo.objects / repo.refs); this module is
// the wire layer. Packs we emit contain plain objects only (no deltas) — the
// suite resolves deltas when a server sends them, and sending none is valid.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  getObject,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  reachable,
  storeObject,
  type GitObject,
  type ObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(head, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a byte stream into sideband packets (band byte + chunk), each a pkt-line. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function packTypeCode(type: ObjectType): number {
  return type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
}

/** Build a PACK v2 buffer from plain objects (no deltas). Order is the caller's. */
export function writePack(objects: Array<{ oid: string; type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    // object header: varint type+size, little-endian 7-bit groups, MSB set except last.
    const size = obj.data.length;
    const typeCode = packTypeCode(obj.type);
    const headerBytes: number[] = [];
    let remaining = size;
    let first = true;
    const groups: number[] = [];
    groups.push(remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      groups.push(remaining & 0x7f);
      remaining >>= 7;
    }
    for (let i = 0; i < groups.length; i += 1) {
      let byte = groups[i];
      if (i === 0) byte |= typeCode << 4;
      if (i < groups.length - 1) byte |= 0x80;
      headerBytes.push(byte);
      first = false;
    }
    void first;
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let next = offset + 1;
  let shift = 7;
  while (buf[next - 1] & 0x80) {
    value |= (buf[next] & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { value, next };
}

/**
 * Parse a PACK v2/v3 buffer and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies objects the client already holds (for thin
 * packs); our own packs never need it. Returns oid -> {type, data}.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Verify the trailer checksum.
  const expected = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  const raw: Array<{ offset: number; typeCode: number; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = buf[offset];
    const typeCode = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (buf[offset - 1] & 0x80) {
      size |= (buf[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = buf[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      const delta = inflateSync(buf.subarray(offset));
      const consumed = compressedLength(buf, offset);
      offset += consumed;
      const data = applyDelta(base.data, delta);
      const entry: PackEntry = { type: base.type, data, oid: hashObject(base.type, data) };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
      void size;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid.
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const delta = inflateSync(buf.subarray(offset));
      const consumed = compressedLength(buf, offset);
      offset += consumed;
      let base = entries.find((e) => e.oid === baseOid);
      if (!base && resolveBase) {
        const resolved = resolveBase(baseOid);
        if (resolved) base = { type: resolved.type, data: resolved.data, oid: baseOid };
      }
      if (!base) throw new Error(`ref-delta base ${baseOid} not found`);
      const data = applyDelta(base.data, delta);
      const entry: PackEntry = { type: base.type, data, oid: hashObject(base.type, data) };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
      void size;
    } else {
      const type = PACK_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const data = inflateSync(buf.subarray(offset));
      const consumed = compressedLength(buf, offset);
      offset += consumed;
      const entry: PackEntry = { type, data, oid: hashObject(type, data) };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
      raw.push({ offset: entryOffset, typeCode, data });
      void size;
    }
  }
  const out = new Map<string, GitObject>();
  for (const entry of entries) out.set(entry.oid, { type: entry.type, data: entry.data });
  return out;
}

function compressedLength(buf: Buffer, offset: number): number {
  // Node's inflateSync ignores bytes after the zlib stream ends and throws on
  // a truncated stream, so the smallest prefix that inflates cleanly is the
  // exact stream length. Binary-search it.
  let lo = 1;
  let hi = buf.length - offset;
  let best = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  // Confirm the best prefix really inflates (guards a corrupt stream).
  inflateSync(buf.subarray(offset, offset + best));
  return best;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarintDelta = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarintDelta();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarintDelta();
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

export const V2_CAPABILITIES: Array<[string, string]> = [
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow'],
  ['object-format', 'sha1'],
];

export const RECEIVE_CAPABILITIES = ['report-status', 'side-band-64k', 'delete-refs'];

export function refList(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** v2 upload-pack advertisement: `version 2` + capability lines + flush. */
export function advertisementV2(): Buffer {
  const lines: Buffer[] = [pktLine('version 2\n')];
  for (const [name, value] of V2_CAPABILITIES) lines.push(pktLine(`${name}=${value}\n`));
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function v0CapabilityString(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const caps: string[] = [];
  if (service === 'git-receive-pack') caps.push(...RECEIVE_CAPABILITIES);
  else caps.push('side-band-64k', 'shallow', 'ofs-delta', 'report-status');
  caps.push(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
  caps.push('agent=forge/1.0');
  return caps.join(' ');
}

/** v0 advertisement for either service: service line, flush, ref lines, flush. */
export function advertisementV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refList(repo);
  const caps = v0CapabilityString(service, repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (headOid) lines.push(`${headOid} HEAD`);
  else lines.push(`${ZERO_OID} HEAD`);
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    lines.push(`${ref.oid} ${ref.name}`);
    const obj = getObject(repo, ref.oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    // Empty repo: advertise capabilities on the pseudo-ref git uses.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      if (index === 0) parts.push(pktLine(`${line}\0${caps}\n`));
      else parts.push(pktLine(`${line}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsRequest(packets: Pkt[]): LsRefsRequest {
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      // Before the delim: the command plus optional agent= / object-format=
      // lines, in any order. Only the command line matters.
      if (line === 'command=ls-refs') sawCommand = true;
      continue;
    }
    if (line === 'peel') req.peel = true;
    else if (line === 'symrefs') req.symrefs = true;
    else if (line === 'unborn') req.unborn = true;
    else if (line.startsWith('ref-prefix ')) req.prefixes.push(line.slice('ref-prefix '.length));
    // agent= / object-format= are accepted and ignored.
  }
  if (!sawCommand) throw new Error('ls-refs request has no command=ls-refs line');
  return req;
}

export function lsRefsResponse(repo: Repo, req: LsRefsRequest): Buffer {
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is always listed (with symref-target) when the client asked for symrefs
  // or when there is nothing else; the suite reads it for the default branch.
  if (req.symrefs && keep('HEAD')) {
    if (headOid) parts.push(pktLine(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else if (req.unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of refList(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (req.peel) {
      const obj = getObject(repo, ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v2)
// ---------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function parseFetchRequest(packets: Pkt[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      // Before the delim: the command plus optional agent= / object-format=
      // lines, in any order. Only the command line matters.
      if (line === 'command=fetch') sawCommand = true;
      continue;
    }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
    // thin-pack, no-progress, ofs-delta, done, agent=, object-format= are accepted.
  }
  if (!sawCommand) throw new Error('fetch request has no command=fetch line');
  return req;
}

interface FetchPlan {
  /** objects to send (oid -> object), in a stable order */
  objects: Array<{ oid: string; type: ObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Decide what a v2 fetch sends. `depth` limits how many commit generations are
 * walked from each want (1 = the want commits only). Objects the client already
 * holds (its haves, with shallow boundaries honoured) are excluded.
 */
export function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const clientShallow = new Set(req.shallow);
  // Objects the client already holds.
  const held = new Set<string>();
  for (const have of req.haves) {
    if (clientShallow.has(have)) {
      // Shallow boundary: the client holds the commit and its tree/blobs, but
      // not the parents.
      const obj = getObject(repo, have);
      if (!obj) continue;
      held.add(have);
      if (obj.type === 'commit') {
        const tree = parseCommit(obj.data).tree;
        for (const oid of reachable(repo, [tree])) held.add(oid);
      } else if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        const peeled = peelToCommit(repo, target);
        if (peeled) {
          held.add(target);
          const commit = getObject(repo, peeled);
          if (commit) for (const oid of reachable(repo, [parseCommit(commit.data).tree])) held.add(oid);
        }
      }
    } else {
      for (const oid of reachable(repo, [have])) held.add(oid);
    }
  }

  // Commits to include: walk `depth` generations from the wants (unbounded
  // when depth is null).
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = req.wants
    .filter((oid) => getObject(repo, oid))
    .map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      included.add(oid);
      const target = parseTag(obj.data).object;
      if (!seen.has(target)) queue.push({ oid: target, depth });
      continue;
    }
    if (obj.type !== 'commit') {
      included.add(oid);
      continue;
    }
    included.add(oid);
    const parents = parseCommit(obj.data).parents;
    if (req.depth !== null && depth + 1 >= req.depth) {
      // This commit is at the depth boundary: its parents stay behind.
      if (parents.length) boundary.add(oid);
      continue;
    }
    for (const parent of parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }

  // Every object the fetch sends: each included commit plus its tree closure
  // (tree + subtrees + blobs) — never the commit's parents, which is what
  // makes a depth limit a limit. Tags contribute themselves; their target is
  // included separately when it is in the included set.
  const send = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      send.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
  };
  for (const oid of included) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    send.add(oid);
    if (obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
    else if (obj.type === 'tree') addTreeClosure(oid);
  }
  for (const oid of held) send.delete(oid);
  // Deterministic order: commits first (topological-ish), then trees, blobs, tags.
  const ordered = [...send].sort((a, b) => {
    const ta = getObject(repo, a)!.type;
    const tb = getObject(repo, b)!.type;
    const rank = (t: ObjectType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
    if (rank(ta) !== rank(tb)) return rank(ta) - rank(tb);
    return a < b ? -1 : 1;
  });
  const objects = ordered.map((oid) => {
    const obj = getObject(repo, oid)!;
    return { oid, type: obj.type, data: obj.data };
  });

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.depth !== null) {
    for (const oid of boundary) shallow.push(oid);
    // A client shallow boundary that is now fully included (its parent is in
    // the included set) stops being shallow.
    for (const oid of req.shallow) {
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (included.has(oid) && parents.every((p) => included.has(p))) unshallow.push(oid);
    }
  }
  const acks = req.haves.filter((have) => getObject(repo, have) !== undefined);
  return { objects, shallow, unshallow, acks };
}

export function fetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // wanted-refs
  const wanted = refList(repo).filter((ref) => req.wants.includes(ref.oid));
  if (wanted.length) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of wanted) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    parts.push(pktDelim());
  }
  // packfile (sideband band 1)
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

export function parsePushRequest(buf: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // The command list is pkt-lines terminated by a flush; the pack follows raw.
  let offset = 0;
  const commands: PushCommand[] = [];
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('truncated push request');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(head, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    const payload = buf.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const parts = command.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const pack = offset < buf.length ? buf.subarray(offset) : null;
  return { commands, pack };
}

/** Apply a push: store the pack objects, then fast-forward (or delete) per ref. */
export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer | null): PushOutcome {
  if (pack && pack.length) {
    const objects = readPack(pack);
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const refs: PushOutcome['refs'] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'old oid does not match' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = getObject(repo, command.newOid);
    if (!target) {
      refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      // Create: old must be zero.
      if (command.oldOid !== ZERO_OID) {
        refs.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'old oid does not match' });
      continue;
    }
    if (command.newOid === current) {
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Fast-forward only: the new tip must descend from the old tip.
    const newCommit = peelToCommit(repo, command.newOid);
    const oldCommit = peelToCommit(repo, current);
    if (newCommit === null || oldCommit === null) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // Walk the new commit's ancestry for the old tip.
    const seen = new Set<string>();
    const stack = [newCommit];
    let fastForward = false;
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === oldCommit) {
        fastForward = true;
        break;
      }
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    if (!fastForward) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

/** The report-status stream, pkt-lined, wrapped in sideband band-1 packets. */
export function pushReportResponse(outcome: PushOutcome, sideband: boolean): Buffer {
  const lines: Buffer[] = [pktLine(`unpack ${outcome.unpackDetail}\n`)];
  for (const ref of outcome.refs) {
    lines.push(ref.ok ? pktLine(`ok ${ref.ref}\n`) : pktLine(`ng ${ref.ref} ${ref.reason}\n`));
  }
  const stream = Buffer.concat(lines);
  if (!sideband) return Buffer.concat([stream, pktFlush()]);
  const packets = sidebandPackets(1, stream);
  packets.push(pktFlush());
  return Buffer.concat(packets);
}

export { storeObject };
