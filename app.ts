// HTTP server: routes every surface of the forge.
//
//   GET  /healthz                                  -> {"ok":true}
//   GET  /{owner}/{repo}.git/info/refs             -> git advertisement (v2/v0)
//   POST /{owner}/{repo}.git/git-upload-pack       -> ls-refs / fetch (protocol v2)
//   POST /{owner}/{repo}.git/git-receive-pack      -> push (protocol v0)
//   /api/v3/*                                      -> REST v3
//   POST /api/graphql                              -> GraphQL
//   POST /mcp                                      -> MCP (Streamable HTTP)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  decodePktLines,
  fetchResponse,
  lsRefsResponse,
  parseFetchRequest,
  parseLsRefsRequest,
  parsePushRequest,
  pushReportResponse,
} from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface AppOptions {
  token: string;
}

export function createApp(options: AppOptions): ReturnType<typeof createServer> {
  const store = new Store();
  const requestSeq = { value: 0 };
  const restCtx = { store, token: options.token, requestSeq };
  const mcpCtx = { store, token: options.token };
  const gqlCtx = { store };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        handleRequest(req, res, body);
      } catch (err) {
        // Never crash the process on a bad request; answer 400 and stay up.
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', () => {
      try {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request'));
      } catch {
        /* socket already gone */
      }
    });
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const headers = new Map<string, string>();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name.toLowerCase(), value);
      else if (Array.isArray(value)) headers.set(name.toLowerCase(), value.join(', '));
    }
    const origin = `http://${req.headers.host ?? 'localhost'}`;

    // Health probe.
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const suffix = gitMatch[3] ?? '';
      handleGit(req, res, body, owner, repoName, suffix, url, method, headers);
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const response = handleRest(restCtx, {
        method,
        path: path === '/api/v3' ? '/api/v3/' : path,
        query: url.searchParams,
        headers,
        body,
        origin,
      });
      sendResponse(res, response.status, response.headers, Buffer.from(response.body, 'utf8'));
      return;
    }

    // GraphQL.
    if (path === '/api/graphql' && method === 'POST') {
      const auth = headers.get('authorization') ?? '';
      if (!auth.startsWith('Bearer ') || !auth.slice('Bearer '.length).trim()) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (options.token && auth.slice('Bearer '.length).trim() !== options.token) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const result = executeGraphQLBody(gqlCtx, parsed);
      sendJson(res, 200, result);
      return;
    }

    // MCP.
    if (path === '/mcp' && method === 'POST') {
      const response = handleMcp(mcpCtx, { headers, body });
      sendResponse(res, response.status, response.headers, Buffer.from(response.body, 'utf8'));
      return;
    }
    if (path === '/mcp' && method === 'DELETE') {
      sendBuffer(res, 200, 'application/json', Buffer.from('{}'));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    owner: string,
    repoName: string,
    suffix: string,
    url: URL,
    method: string,
    headers: Map<string, string>,
  ): void {
    const repo = store.getRepo(owner, repoName);
    const gitProtocol = headers.get('git-protocol') ?? '';

    if (suffix === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (!repo) {
        sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found'));
        return;
      }
      if (service === 'git-upload-pack') {
        if (gitProtocol === 'version=2') {
          sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
        } else {
          sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV0('git-upload-pack', repo));
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertisementV0('git-receive-pack', repo));
        return;
      }
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service'));
      return;
    }

    if (suffix === '/git-upload-pack' && method === 'POST') {
      if (!repo) {
        sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found'));
        return;
      }
      if (gitProtocol !== 'version=2') {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('protocol v2 required'));
        return;
      }
      let packets;
      try {
        packets = decodePktLines(body);
      } catch {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line'));
        return;
      }
      const firstLine = packets.find((p) => p.kind === 'data');
      const command = firstLine && firstLine.kind === 'data' ? firstLine.payload.toString('utf8').replace(/\n$/, '') : '';
      if (command === 'command=ls-refs') {
        const request = parseLsRefsRequest(packets);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, request));
        return;
      }
      if (command === 'command=fetch') {
        const request = parseFetchRequest(packets);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, request));
        return;
      }
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown v2 command'));
      return;
    }

    if (suffix === '/git-receive-pack' && method === 'POST') {
      if (!repo) {
        sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found'));
        return;
      }
      let parsed;
      try {
        parsed = parsePushRequest(body);
      } catch {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed push request'));
        return;
      }
      // The client negotiates side-band-64k when the advertisement offers it.
      const sideband = body.toString('utf8').includes('side-band-64k');
      let outcome;
      try {
        outcome = applyPush(repo, parsed.commands, parsed.pack);
      } catch (err) {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`unpack error: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', pushReportResponse(outcome, sideband));
      return;
    }

    sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found'));
  }

  function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    sendBuffer(res, status, 'application/json; charset=utf-8', body);
  }

  function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
    res.end(body);
  }

  function sendResponse(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
    const merged: Record<string, string> = { ...headers };
    if (!('content-length' in merged)) merged['content-length'] = String(body.length);
    res.writeHead(status, merged);
    res.end(body);
  }

  void VIEWER;
  return server;
}
