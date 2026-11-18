// In-memory store for the forge: repositories, issues, pull requests, labels,
// comments, and the git object store (refs + objects) backing every repo.
//
// Everything lives in memory. The trial pod runs one process and the suite
// creates its fixtures fresh through the entry's own REST/git surfaces, so no
// persistence is needed. All timestamps use the contest's fixed epoch so that
// commit ids are deterministic across runs.

import { createHash } from 'node:crypto';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Fixed epoch (2025-01-01T00:00:00Z) used for every commit this forge creates. */
export const EPOCH_SEC = 1_735_689_600;

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** ref name -> commit/tag oid */
  refs: Map<string, string>;
  /** oid -> git object */
  objects: Map<string, GitObject>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: ++this.seq,
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      refs: new Map(),
      objects: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// git object helpers (pure functions over a repo's object map)
// ---------------------------------------------------------------------------------------------

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Resolve a ref oid to the commit it points at (peeling annotated tags). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
}

/** All oids reachable from the given oids (commits, trees, blobs, tags). */
export function reachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `oid` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Read a file tree: path -> blob oid, for the tree at `treeOid`. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, oid] of flattenTree(repo, entry.oid, path)) out.set(p, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** Build (and store) a tree object from a flat path -> {mode, oid} map. */
export function buildTreeFromPaths(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** Create a commit object (stored) and return its oid. */
export function createCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
  timestampSec: number = EPOCH_SEC,
): string {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${timestampSec} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Opaque, stable global id for a repo (never the bare numeric id). */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`issue:${repo.id}:${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`pr:${repo.id}:${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`comment:${repo.id}:${issueNumber}:${commentId}`, 'utf8').toString('base64');
}

/**
 * Squash-merge a pull request onto its base branch with a three-way merge.
 * Returns the merge commit oid, or null when the merge conflicts (any file
 * changed differently on both sides of the merge base).
 */
export function squashMergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'missing branch' };
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  const mergeBaseCommit = peelToCommit(repo, pull.baseSha);
  if (!baseCommit || !headCommit || !mergeBaseCommit) return { ok: false, reason: 'missing commit' };
  const baseObj = repo.objects.get(mergeBaseCommit);
  const oursObj = repo.objects.get(baseCommit);
  const theirsObj = repo.objects.get(headCommit);
  if (!baseObj || !oursObj || !theirsObj) return { ok: false, reason: 'missing object' };
  const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
  const oursFiles = flattenTree(repo, parseCommit(oursObj.data).tree);
  const theirsFiles = flattenTree(repo, parseCommit(theirsObj.data).tree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const allPaths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const p of allPaths) {
    const b = baseFiles.get(p);
    const o = oursFiles.get(p);
    const t = theirsFiles.get(p);
    if (o === t) {
      if (o !== undefined) merged.set(p, { mode: '100644', oid: o });
    } else if (b === o) {
      if (t !== undefined) merged.set(p, { mode: '100644', oid: t });
    } else if (b === t) {
      if (o !== undefined) merged.set(p, { mode: '100644', oid: o });
    } else {
      return { ok: false, reason: 'conflict' };
    }
  }
  const treeOid = buildTreeFromPaths(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const mergeCommit = createCommit(repo, treeOid, [baseCommit, headCommit], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(EPOCH_SEC * 1000).toISOString();
  pull.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit };
}

export type GlobalId =
  | { kind: 'repo'; repoId: number }
  | { kind: 'issue'; repoId: number; number: number }
  | { kind: 'pr'; repoId: number; number: number }
  | { kind: 'comment'; repoId: number; issueNumber: number; commentId: number };

export function decodeGlobalId(id: string): GlobalId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoId: Number(parts[1]) };
    if (parts[0] === 'issue' && parts.length === 3) return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'pr' && parts.length === 3) return { kind: 'pr', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'comment' && parts.length === 4) {
      return { kind: 'comment', repoId: Number(parts[1]), issueNumber: Number(parts[2]), commentId: Number(parts[3]) };
    }
  } catch {
    return null;
  }
  return null;
}
