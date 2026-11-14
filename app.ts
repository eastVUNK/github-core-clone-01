// The HTTP server: one Node process, no dependencies, stdlib only.
//
// Routes:
//   GET  /healthz                     200 {ok:true}, no auth (boot probe x2)
//   /{owner}/{repo}.git/info/refs    git advertisements (v0/v2)
//   /{owner}/{repo}.git/git-upload-pack   upload-pack v2 (+ v0 fallback)
//   /{owner}/{repo}.git/git-receive-pack  receive-pack v0
//   /api/v3/...                       REST v3 (rest.ts)
//   /api/graphql, /mcp               Stage 4 — 404 JSON until then
//
// Auth: the suite presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
// When the env var is set, the token must match it exactly; when it is not
// set (a local run without the env), any non-empty bearer is accepted. A
// missing bearer is 401 everywhere except GET /api/v3/ and /healthz.
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import {
  applyPush,
  lsRefs,
  lsRefsBody,
  parseReceivePackBody,
  parseUploadPackBody,
  parseV2Command,
  pushReportBody,
  selectFetchObjects,
  v0Advertisement,
  v0FetchBody,
  v2Advertisement,
  v2FetchBody,
  ZERO_OID,
} from './git.ts';

const TOKEN_ENV = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null) return false;
  const token = match[1]!;
  if (TOKEN_ENV !== '') return token === TOKEN_ENV;
  return token.length > 0;
}

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  const json = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'x-github-request-id': `req-${++requestSeq}`,
      ...extraHeaders,
    });
    res.end(payload);
  };

  const gitResult = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (path === '/healthz') {
        if (method !== 'GET') {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      // ---- git smart HTTP ----
      const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = gitMatch[1]!;
        const repoName = gitMatch[2]!;
        const service = gitMatch[3]!;
        if (!bearerOk(req)) {
          json(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (owner !== VIEWER_LOGIN) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        if (service === 'info/refs') {
          const wanted = url.searchParams.get('service') ?? '';
          if (wanted === 'git-upload-pack') {
            if ((req.headers['git-protocol'] ?? '') === 'version=2') {
              gitResult(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
            } else {
              gitResult(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
            }
            return;
          }
          if (wanted === 'git-receive-pack') {
            gitResult(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
            return;
          }
          json(res, 404, { message: 'Not Found' });
          return;
        }

        const body = await readBody(req);
        if (service === 'git-upload-pack') {
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          try {
            if (isV2) {
              const { command, args } = parseV2Command(body);
              if (command === 'ls-refs') {
                const prefixes = args.get('ref-prefix') ?? [];
                const refs = lsRefs(repo, prefixes, args.has('peel'), args.has('symrefs'));
                gitResult(res, 200, 'application/x-git-upload-pack-result', lsRefsBody(refs));
                return;
              }
              if (command === 'fetch') {
                const request = parseUploadPackBody(body, 2);
                const selection = selectFetchObjects(repo, request.wants, request.haves, request.deepen, request.shallow);
                gitResult(res, 200, 'application/x-git-upload-pack-result', v2FetchBody(selection));
                return;
              }
              json(res, 400, { message: `unknown v2 command ${command}` });
              return;
            }
            const request = parseUploadPackBody(body, 0);
            const selection = selectFetchObjects(repo, request.wants, request.haves, request.deepen, request.shallow);
            gitResult(res, 200, 'application/x-git-upload-pack-result', v0FetchBody(selection));
          } catch (err) {
            json(res, 400, { message: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // git-receive-pack (v0 only)
        try {
          const { commands, pack } = parseReceivePackBody(body);
          const report = applyPush(repo, commands, pack);
          gitResult(res, 200, 'application/x-git-receive-pack-result', pushReportBody(report, true, 'ok'));
        } catch (err) {
          json(res, 400, { message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ---- REST v3 ----
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const isRoot = path === '/api/v3' || path === '/api/v3/';
        if (!isRoot && !bearerOk(req)) {
          json(res, 401, { message: 'Requires authentication' });
          return;
        }
        const segments = path.split('/').filter((part) => part !== '').slice(2);
        let parsedBody: unknown = undefined;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              parsedBody = JSON.parse(raw.toString('utf8')) as unknown;
            } catch {
              json(res, 400, { message: 'Invalid JSON body' });
              return;
            }
          }
        }
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
        const reply = handleRest(store, method, segments, url.searchParams, parsedBody, baseUrl);
        if (reply.empty === true) {
          res.writeHead(reply.status, { 'x-github-request-id': `req-${++requestSeq}` });
          res.end();
          return;
        }
        json(res, reply.status, reply.body, reply.headers as Record<string, string> | undefined);
        return;
      }

      // ---- not yet built (Stage 4) ----
      if (path === '/api/graphql' || path === '/mcp') {
        if (!bearerOk(req)) {
          json(res, 401, { message: 'Requires authentication' });
          return;
        }
        json(res, 404, { message: 'Not Found' });
        return;
      }

      json(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        json(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy();
      }
    }
  });
}

export { ZERO_OID };
