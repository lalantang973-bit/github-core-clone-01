// REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. Errors
// are JSON {message}. Auth is a Bearer token; a missing token is 401. A repo
// under any owner other than the token owner is 404, never 403.

import {
  VIEWER,
  EPOCH_SEC,
  buildTreeFromPaths,
  createCommit,
  flattenTree,
  getObject,
  hashObject,
  parseCommit,
  parseTree,
  peelToCommit,
  squashMergePull,
  storeObject,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  /** The token the entry was started with (empty when unset). */
  token: string;
  /** Request counter for X-GitHub-Request-Id. */
  requestSeq: { value: number };
}

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  /** Absolute origin (scheme://host) for pagination Link headers. */
  origin: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SHA40 = /^[0-9a-f]{40}$/i;

function jsonResponse(ctx: RestContext, status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  ctx.requestSeq.value += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${ctx.requestSeq.value.toString(16).padStart(8, '0')}`,
    ...extraHeaders,
  };
  return { status, headers, body: body === null ? '' : JSON.stringify(body) };
}

function errorResponse(ctx: RestContext, status: number, message: string): RestResponse {
  return jsonResponse(ctx, status, { message });
}

function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function isAuthed(ctx: RestContext, req: RestRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return false;
  if (ctx.token && token !== ctx.token) return false;
  return true;
}

function ownerOf(ctx: RestContext, req: RestRequest): string {
  void ctx;
  void req;
  return VIEWER.login;
}

/** Resolve a repo or answer the right error (401/404). */
function resolveRepo(
  ctx: RestContext,
  req: RestRequest,
  owner: string,
  name: string,
): { repo: Repo } | RestResponse {
  if (!isAuthed(ctx, req)) return errorResponse(ctx, 401, 'Requires authentication');
  if (owner !== VIEWER.login) return errorResponse(ctx, 404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return errorResponse(ctx, 404, 'Not Found');
  return { repo };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

function issueJson(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

/** Paginate a list; returns the page and a Link header value when more pages exist. */
function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(baseUrl);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
    const last = new URL(baseUrl);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    link += `, <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeader(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

/** Resolve a ref name / oid to a commit oid, or null. */
function resolveRefToCommit(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ? peelToCommit(repo, tip) : null;
  }
  if (SHA40.test(ref)) return peelToCommit(repo, ref);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return peelToCommit(repo, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return peelToCommit(repo, tag);
  const direct = repo.refs.get(ref);
  if (direct) return peelToCommit(repo, direct);
  return null;
}

/** Walk commits from `tip` newest-first (linear history in the suite). */
function walkCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string }> {
  const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ sha: oid, message: info.message, author: info.author, committer: info.committer });
    // Parents in reverse so the first parent is visited first.
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

function commitJson(entry: { sha: string; message: string; author: string; committer: string }): Record<string, unknown> {
  const parseIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (!match) return { name: ident, email: '', date: new Date(EPOCH_SEC * 1000).toISOString() };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  const author = parseIdent(entry.author);
  const committer = parseIdent(entry.committer);
  return {
    sha: entry.sha,
    commit: {
      // The REST view presents the message without the trailing newline the
      // stored commit object carries.
      message: entry.message.replace(/\n$/, ''),
      author,
      committer,
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
  };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/** Diff two file maps (path -> blob oid) into pull-file entries. */
function diffFiles(repo: Repo, baseFiles: Map<string, string>, headFiles: Map<string, string>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === headOid) continue;
    if (baseOid === undefined && headOid !== undefined) {
      const blob = getObject(repo, headOid);
      const lines = blob ? countLines(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (headOid === undefined && baseOid !== undefined) {
      const blob = getObject(repo, baseOid);
      const lines = blob ? countLines(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (baseOid !== undefined && headOid !== undefined) {
      const oldBlob = getObject(repo, baseOid);
      const newBlob = getObject(repo, headOid);
      const oldLines = oldBlob ? countLines(oldBlob.data.toString('utf8')) : 0;
      const newLines = newBlob ? countLines(newBlob.data.toString('utf8')) : 0;
      const additions = Math.max(1, newLines);
      const deletions = Math.max(0, oldLines);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export function handleRest(ctx: RestContext, req: RestRequest): RestResponse {
  const { method, path } = req;
  const segments = path.split('/').filter((s) => s.length > 0);

  // All /api/v3 routes need a token.
  if (!isAuthed(ctx, req)) return errorResponse(ctx, 401, 'Requires authentication');

  // GET /api/v3/
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3' && method === 'GET') {
    return jsonResponse(ctx, 200, { current_user_url: `${req.origin}/api/v3/user` }, { 'x-oauth-scopes': 'repo' });
  }
  // GET /api/v3/meta
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta' && method === 'GET') {
    return jsonResponse(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  // GET /api/v3/user/repos  +  POST /api/v3/user/repos
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listReposByOwner(VIEWER.login);
      const { page, link } = paginate(repos, req.query, `${req.origin}${path}`);
      return jsonResponse(ctx, 200, page.map(repoJson), linkHeader(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return errorResponse(ctx, 422, 'name is invalid');
      }
      if (ctx.store.getRepo(VIEWER.login, name)) {
        return errorResponse(ctx, 422, 'Repository already exists');
      }
      const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
      const isPrivate = parsed.value.private === true;
      const repo = ctx.store.createRepo(VIEWER.login, name, description, isPrivate);
      return jsonResponse(ctx, 201, repoJson(repo));
    }
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const name = decodeURIComponent(segments[4]);
    const rest = segments.slice(5);
    const resolved = resolveRepo(ctx, req, owner, name);
    if ('status' in resolved) return resolved;
    const repo = resolved.repo;

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return jsonResponse(ctx, 200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
        return jsonResponse(ctx, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return jsonResponse(ctx, 204, null);
      }
    }

    // GET /branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([refName]) => refName.startsWith('refs/heads/'))
        .map(([refName, oid]) => ({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return jsonResponse(ctx, 200, branches);
    }

    // GET /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const tip = resolveRefToCommit(repo, req.query.get('sha') ?? undefined);
      if (tip === null) return jsonResponse(ctx, 200, []);
      const commits = walkCommits(repo, tip);
      const { page, link } = paginate(commits, req.query, `${req.origin}${path}`);
      return jsonResponse(ctx, 200, page.map(commitJson), linkHeader(link));
    }

    // /git/refs
    if (rest.length >= 1 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) {
          return errorResponse(ctx, 422, 'ref or sha is invalid');
        }
        if (repo.refs.has(ref)) return errorResponse(ctx, 422, 'Reference already exists');
        const target = getObject(repo, sha);
        if (!target) return errorResponse(ctx, 422, 'object does not exist');
        repo.refs.set(ref, sha);
        return jsonResponse(ctx, 201, { ref, object: { sha, type: target.type } });
      }
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([refName, oid]) => ({ ref: refName, object: { sha: oid } }));
        return jsonResponse(ctx, 200, refs);
      }
    }

    // /labels
    if (rest.length >= 1 && rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const labelName = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        if (!labelName) return errorResponse(ctx, 422, 'name is required');
        const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
        const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
        const existing = repo.labels.get(labelName);
        if (existing) return jsonResponse(ctx, 200, { name: existing.name, color: existing.color, description: existing.description });
        repo.labels.set(labelName, { name: labelName, color, description });
        return jsonResponse(ctx, 201, { name: labelName, color, description });
      }
      if (method === 'GET' && rest.length === 1) {
        return jsonResponse(ctx, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      }
    }

    // /contents/<path...>
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const refParam = req.query.get('ref') ?? undefined;
        const commitOid = resolveRefToCommit(repo, refParam);
        if (commitOid === null) return errorResponse(ctx, 404, 'Not Found');
        const commit = getObject(repo, commitOid);
        if (!commit || commit.type !== 'commit') return errorResponse(ctx, 404, 'Not Found');
        const files = flattenTree(repo, parseCommit(commit.data).tree);
        if (filePath === '' || filePath === '/') {
          // Root directory listing.
          const entries = listDirectory(repo, parseCommit(commit.data).tree, '');
          return jsonResponse(ctx, 200, entries);
        }
        const blobOid = files.get(filePath);
        if (blobOid) {
          const blob = getObject(repo, blobOid)!;
          return jsonResponse(ctx, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: blob.data.toString('base64'),
            sha: blobOid,
          });
        }
        // Maybe a directory.
        const dirEntries = listDirectoryAt(repo, parseCommit(commit.data).tree, filePath);
        if (dirEntries !== null) return jsonResponse(ctx, 200, dirEntries);
        return errorResponse(ctx, 404, 'Not Found');
      }
      if (method === 'PUT') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
        const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
        const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorResponse(ctx, 422, 'content is not valid base64');
        }
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        const tipCommit = tip ? peelToCommit(repo, tip) : null;
        const files = new Map<string, { mode: string; oid: string }>();
        if (tipCommit) {
          const commit = getObject(repo, tipCommit)!;
          for (const [p, oid] of flattenTree(repo, parseCommit(commit.data).tree)) files.set(p, { mode: '100644', oid });
        }
        const existing = files.get(filePath);
        if (sha !== undefined) {
          if (!existing || existing.oid.toLowerCase() !== sha.toLowerCase()) {
            return errorResponse(ctx, 409, 'sha does not match the current file');
          }
        }
        const blobOid = storeObject(repo, 'blob', content);
        files.set(filePath, { mode: '100644', oid: blobOid });
        const treeOid = buildTreeFromPaths(repo, files);
        const parents = tipCommit ? [tipCommit] : [];
        const commitOid = createCommit(repo, treeOid, parents, message);
        repo.refs.set(refName, commitOid);
        const status = existing ? 200 : 201;
        return jsonResponse(ctx, status, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitOid },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
        const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        const tipCommit = tip ? peelToCommit(repo, tip) : null;
        if (!tipCommit) return errorResponse(ctx, 404, 'Not Found');
        const commit = getObject(repo, tipCommit)!;
        const files = new Map<string, { mode: string; oid: string }>();
        for (const [p, oid] of flattenTree(repo, parseCommit(commit.data).tree)) files.set(p, { mode: '100644', oid });
        const existing = files.get(filePath);
        if (!existing) return errorResponse(ctx, 404, 'Not Found');
        if (sha !== undefined && existing.oid.toLowerCase() !== sha.toLowerCase()) {
          return errorResponse(ctx, 409, 'sha does not match the current file');
        }
        files.delete(filePath);
        const treeOid = buildTreeFromPaths(repo, files);
        const commitOid = createCommit(repo, treeOid, [tipCommit], message);
        repo.refs.set(refName, commitOid);
        return jsonResponse(ctx, 200, { commit: { sha: commitOid } });
      }
    }

    // /issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      // POST /issues
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return errorResponse(ctx, 422, `Label "${label}" does not exist`);
        }
        const number = repo.nextIssueNumber++;
        const issue = {
          number,
          title,
          body,
          state: 'open' as const,
          labels,
          comments: [] as never[],
          createdSeq: ++ctx.store.seq,
        };
        repo.issues.set(number, issue);
        return jsonResponse(ctx, 201, issueJson(repo, issue));
      }
      // GET /issues
      if (rest.length === 1 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        } else {
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, link } = paginate(issues, req.query, `${req.origin}${path}`);
        return jsonResponse(ctx, 200, page.map((i) => issueJson(repo, i)), linkHeader(link));
      }
      // /issues/{n}...
      const issueNumber = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(issueNumber) && issueNumber > 0) {
        const issue = repo.issues.get(issueNumber);
        if (!issue) return errorResponse(ctx, 404, 'Not Found');
        if (rest.length === 2 && method === 'GET') return jsonResponse(ctx, 200, issueJson(repo, issue));
        if (rest.length === 2 && method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          return jsonResponse(ctx, 200, issueJson(repo, issue));
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'POST') {
            const parsed = parseBody(req);
            if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
            const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
            const comment = { id: repo.nextCommentId++, body, createdSeq: ++ctx.store.seq };
            issue.comments.push(comment);
            return jsonResponse(ctx, 201, { id: comment.id, body: comment.body });
          }
          if (method === 'GET') {
            return jsonResponse(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
          }
        }
      }
    }

    // /pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errorResponse(ctx, 400, 'Problems parsing JSON');
        const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
        const base = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const headOid = repo.refs.get(`refs/heads/${head}`);
        const baseOid = repo.refs.get(`refs/heads/${base}`);
        if (!headOid || !baseOid) return errorResponse(ctx, 422, 'head or base branch does not exist');
        const number = repo.nextPullNumber++;
        const pull = {
          number,
          title,
          body,
          headRef: head,
          baseRef: base,
          headSha: headOid,
          baseSha: baseOid,
          state: 'open' as const,
          merged: false,
          mergedAt: null as string | null,
          mergeCommitSha: null as string | null,
          createdSeq: ++ctx.store.seq,
        };
        repo.pulls.set(number, pull);
        return jsonResponse(ctx, 201, pullJson(repo, pull));
      }
      if (rest.length === 1 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, link } = paginate(pulls, req.query, `${req.origin}${path}`);
        return jsonResponse(ctx, 200, page.map((p) => pullJson(repo, p)), linkHeader(link));
      }
      const pullNumber = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(pullNumber) && pullNumber > 0) {
        const pull = repo.pulls.get(pullNumber);
        if (!pull) return errorResponse(ctx, 404, 'Not Found');
        if (rest.length === 2 && method === 'GET') return jsonResponse(ctx, 200, pullJson(repo, pull));
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const baseCommit = peelToCommit(repo, pull.baseSha);
          const headCommit = peelToCommit(repo, pull.headSha);
          if (!baseCommit || !headCommit) return jsonResponse(ctx, 200, []);
          const baseObj = getObject(repo, baseCommit);
          const headObj = getObject(repo, headCommit);
          if (!baseObj || !headObj) return jsonResponse(ctx, 200, []);
          const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
          const headFiles = flattenTree(repo, parseCommit(headObj.data).tree);
          return jsonResponse(ctx, 200, diffFiles(repo, baseFiles, headFiles));
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull.merged) {
            return jsonResponse(ctx, 200, { merged: true, sha: pull.mergeCommitSha, message: 'Already merged' });
          }
          const result = squashMergePull(repo, pull);
          if (!result.ok) {
            if (result.reason === 'conflict') return errorResponse(ctx, 405, 'Merge conflict');
            return errorResponse(ctx, 404, 'Not Found');
          }
          return jsonResponse(ctx, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
        }
      }
    }
  }

  return errorResponse(ctx, 404, 'Not Found');
}

/** List the entries of a directory tree at a path ('' = root). Null when absent. */
function listDirectoryAt(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> | null {
  const parts = dirPath === '' ? [] : dirPath.split('/');
  let current = treeOid;
  for (const part of parts) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return listDirectory(repo, current, dirPath);
}

function listDirectory(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
  }));
}

export { hashObject };
