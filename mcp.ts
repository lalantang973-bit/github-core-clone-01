// MCP (Model Context Protocol) at /mcp: JSON-RPC 2.0 Streamable HTTP, modern era
// (revision 2026-07-28 via server/discover). Tools share the same store as REST
// and GraphQL. No session is issued; every request is stateless.

import {
  VIEWER,
  squashMergePull,
  type Repo,
  type Store,
} from './store.ts';

export interface McpContext {
  store: Store;
  token: string;
}

export interface McpRequest {
  headers: Map<string, string>;
  body: Buffer;
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function jsonRpc(id: unknown, result: unknown): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
  };
}

function jsonRpcError(id: unknown, code: number, message: string): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
  };
}

function toolResult(data: unknown, isError = false): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
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
  };
}

function issueJson(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
  };
}

function resolveRepo(ctx: McpContext, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, repoName) ?? null;
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    // Unknown tool is reported as a JSON-RPC error by the caller.
    return toolResult(`Unknown tool: ${name}`, true);
  }
  const required = tool.inputSchema.required ?? [];
  const missing = missingArgs(args, required);
  if (missing.length) {
    return toolResult(`Missing required argument(s): ${missing.join(', ')}`, true);
  }

  switch (name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER.login;
      const repoName = String(args.name ?? '');
      if (owner !== VIEWER.login) return toolResult(`Cannot create a repository under owner ${owner}`, true);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
        return toolResult(`Invalid repository name ${JSON.stringify(repoName)}`, true);
      }
      let repo = ctx.store.getRepo(owner, repoName);
      if (!repo) {
        const description = typeof args.description === 'string' ? args.description : '';
        const isPrivate = args.private === true;
        repo = ctx.store.createRepo(owner, repoName, description, isPrivate);
      }
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(ctx, args);
      if (!repo) return toolResult(`Repository not found`, true);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(ctx, args);
      if (!repo) return toolResult('Repository not found', true);
      const number = repo.nextIssueNumber++;
      const issue = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
        createdSeq: ++ctx.store.seq,
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(ctx, args);
      if (!repo) return toolResult('Repository not found', true);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      const list = issues.map((i) => issueJson(repo, i));
      return toolResult({ issues: list });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (!repo) return toolResult('Repository not found', true);
      const head = String(args.head ?? '');
      const base = String(args.base ?? repo.defaultBranch);
      const headOid = repo.refs.get(`refs/heads/${head}`);
      const baseOid = repo.refs.get(`refs/heads/${base}`);
      if (!headOid || !baseOid) return toolResult('head or base branch does not exist', true);
      const number = repo.nextPullNumber++;
      const pull = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (!repo) return toolResult('Repository not found', true);
      const pullNumber = Number(args.pull_number);
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return toolResult(`Pull request ${pullNumber} not found`, true);
      if (!pull.merged) {
        const result = squashMergePull(repo, pull);
        if (!result.ok) return toolResult(`Merge failed: ${result.reason}`, true);
      }
      return toolResult({ ...pullJson(repo, pull), merged: true });
    }
    default:
      return toolResult(`Unknown tool: ${name}`, true);
  }
}

export function handleMcp(ctx: McpContext, req: McpRequest): McpResponse {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !auth.slice('Bearer '.length).trim()) {
    return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Requires authentication' }) };
  }
  if (ctx.token && auth.slice('Bearer '.length).trim() !== ctx.token) {
    return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Requires authentication' }) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700. Try to recover the id.
    const text = req.body.toString('utf8');
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    let id: unknown = null;
    if (idMatch) {
      try {
        id = JSON.parse(idMatch[1]);
      } catch {
        id = null;
      }
    }
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const request = parsed as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = request.id;
  const method = request.method ?? '';

  // Notifications carry no id and expect no response body.
  if (id === undefined) {
    return { status: 202, headers: {}, body: '' };
  }

  if (method === 'server/discover') {
    return jsonRpc(id, {
      resultType: 'discover',
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'initialize') {
    return jsonRpc(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return jsonRpc(id, {});
  }

  if (method === 'tools/list') {
    // Byte-identical on every call: the same literal order and content.
    return jsonRpc(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    const result = callTool(ctx, toolName, args);
    return jsonRpc(id, result);
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
