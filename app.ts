// HTTP server core: request plumbing (ctx, routing, auth, errors) and the first
// GitHub-API routes. Feature modules register their routes at the marker below.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import { registerRepos } from './repos.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** An HTTP error a handler can throw to answer with `status` and `{ message }`. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  jsonBody(): unknown;
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  send(status: number, body: Buffer | string, contentType: string, headers?: Record<string, string>): void;
  empty(status: number): void;
}

export interface Router {
  add(method: string, pattern: string, handler: (ctx: Ctx) => void | Promise<void>): void;
}

interface Route {
  method: string;
  pattern: string;
  handler: (ctx: Ctx) => void | Promise<void>;
}

const routes: Route[] = [];

export function createRouter(): Router {
  return {
    add(method: string, pattern: string, handler: (ctx: Ctx) => void | Promise<void>): void {
      routes.push({ method, pattern, handler });
    },
  };
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

interface Seg {
  kind: 'literal' | 'param' | 'paramSuffix' | 'rest';
  value: string;
  suffix?: string;
}

function parseSeg(seg: string): Seg {
  if (seg === '{...}') return { kind: 'literal', value: seg };
  if (seg.endsWith('...}') && seg.startsWith('{')) {
    return { kind: 'rest', value: seg.slice(1, -4) };
  }
  if (seg.startsWith('{') && seg.includes('}')) {
    const close = seg.indexOf('}');
    const name = seg.slice(1, close);
    const suffix = seg.slice(close + 1);
    if (name.endsWith('...')) return { kind: 'rest', value: name.slice(0, -3) };
    if (name.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      if (suffix === '') return { kind: 'param', value: name };
      return { kind: 'paramSuffix', value: name, suffix };
    }
  }
  return { kind: 'literal', value: seg };
}

function splitPath(p: string): string[] {
  return p.split('/');
}

function matchRoute(route: Route, method: string, pathSegs: string[]): Record<string, string> | null {
  if (route.method !== method) return null;
  const patSegs = splitPath(route.pattern);
  const hasRest = parseSeg(patSegs[patSegs.length - 1]).kind === 'rest';
  if (!hasRest && patSegs.length !== pathSegs.length) return null;
  if (hasRest && pathSegs.length < patSegs.length - 1) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    const seg = parseSeg(patSegs[i]);
    const raw = pathSegs[i];
    switch (seg.kind) {
      case 'literal':
        if (raw === undefined || raw !== seg.value) return null;
        break;
      case 'param':
        if (raw === undefined) return null;
        params[seg.value] = decodeSeg(raw);
        break;
      case 'paramSuffix': {
        if (raw === undefined) return null;
        const suffix = seg.suffix ?? '';
        if (suffix === '' || !raw.endsWith(suffix)) return null;
        params[seg.value] = decodeSeg(raw.slice(0, raw.length - suffix.length));
        break;
      }
      case 'rest':
        params[seg.value] = decodeSeg(pathSegs.slice(i).join('/'));
        return params;
    }
  }
  return params;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const router = createRouter();

  router.add('GET', '/healthz', (ctx) => {
    ctx.json(200, { ok: true });
  });

  router.add('GET', '/api/v3', (ctx) => {
    ctx.json(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  });

  router.add('GET', '/api/v3/', (ctx) => {
    ctx.json(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  });

  router.add('GET', '/api/v3/meta', (ctx) => {
    ctx.json(200, { installed_version: '1.0.0' });
  });

  router.add('GET', '/api/v3/user', (ctx) => {
    ctx.json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, type: 'User' });
  });

  // === feature modules ===
  registerRepos(router);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const method = req.method ?? 'GET';

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the raw pathname
    }
    const query = url.searchParams;
    const headers = req.headers;

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void handle();
    });
    req.on('error', () => {
      // A failed body read still gets an answer.
      void handle(Buffer.concat(chunks));
    });

    async function handle(): Promise<void> {
      const rawBody = Buffer.concat(chunks);
      let responded = false;

      const ctx: Ctx = {
        method,
        path,
        params: {},
        query,
        headers,
        rawBody,
        jsonBody(): unknown {
          try {
            return JSON.parse(rawBody.toString('utf8'));
          } catch {
            throw new HttpError(400, 'Problems parsing JSON');
          }
        },
        json(status: number, body: unknown, extra?: Record<string, string>): void {
          const text = `${JSON.stringify(body)}\n`;
          res.writeHead(status, {
            'content-type': JSON_TYPE,
            'content-length': Buffer.byteLength(text),
            'x-github-request-id': requestId,
            ...extra,
          });
          res.end(text);
          responded = true;
        },
        send(status: number, body: Buffer | string, contentType: string, extra?: Record<string, string>): void {
          const buf = typeof body === 'string' ? Buffer.from(body) : body;
          res.writeHead(status, {
            'content-type': contentType,
            'content-length': buf.length,
            'x-github-request-id': requestId,
            ...extra,
          });
          res.end(buf);
          responded = true;
        },
        empty(status: number): void {
          res.writeHead(status, { 'x-github-request-id': requestId });
          res.end();
          responded = true;
        },
      };

      try {
        // Auth: everything except the health probe requires the bearer token when set.
        const exempt = method === 'GET' && path === '/healthz';
        if (!exempt) {
          const token = process.env.MAKEFUN_SHOP_TOKEN;
          if (token !== undefined && token !== '') {
            if (headers.authorization !== `Bearer ${token}`) {
              ctx.json(401, { message: 'Bad credentials' });
              return;
            }
          }
        }

        const pathSegs = splitPath(path);
        let matched = false;
        for (const route of routes) {
          const params = matchRoute(route, method, pathSegs);
          if (params !== null) {
            ctx.params = params;
            matched = true;
            await route.handler(ctx);
            break;
          }
        }
        if (!matched) {
          ctx.json(404, { message: 'Not Found' });
        }
      } catch (err) {
        if (responded) return;
        if (err instanceof HttpError) {
          ctx.json(err.status, { message: err.message });
        } else {
          console.error(err);
          ctx.json(500, { message: 'Internal Server Error' });
        }
      }
    }
  });
}
