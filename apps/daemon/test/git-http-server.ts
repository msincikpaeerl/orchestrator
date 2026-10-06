import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join } from 'node:path';

// A local Git HTTP remote asking for Basic authentication (ADR 0027): `git http-backend` behind
// a small server, so credential tests use Git's real HTTP client and credential helpers. The
// fake GitHub (apps/server/test/fake-github.ts) mounts the same handler with its own token checks.

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** Requests received: whether each carried the right credential, and whether it pushes. */
  requests: { path: string; authenticated: boolean; push: boolean }[];
  close(): Promise<void>;
}

/** What a Git request asks for, as the handler reads it before any authentication. */
export interface GitHttpRequest {
  /** `owner` and `name` of `/<owner>/<name>.git/...`. */
  owner: string;
  name: string;
  /** `push` for `git-receive-pack`, `fetch` for everything else. */
  access: 'fetch' | 'push';
  /** From the Basic `Authorization` header; null when absent or not Basic. */
  credential: { username: string; password: string } | null;
}

export type GitHttpDecision =
  | {
      /** The bare repository to serve. */
      repository: string;
      /** Name given to `git http-backend` as `REMOTE_USER`. */
      user: string;
      /** More variables for `git http-backend` and the repository's hooks. */
      env?: Record<string, string>;
    }
  | { status: number; message?: string; headers?: Record<string, string> };

export interface GitHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Stops every `git http-backend` still running and waits until each has exited. */
  close(): Promise<void>;
}

/** Variables that keep the backend and the hooks away from the user's own Git configuration. */
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function parseCredential(header: string | undefined): GitHttpRequest['credential'] {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Serves `/<owner>/<name>.git/...` with `git http-backend`, after `authorize` decides. `onPushed`
 * is called once a push request has ended (whatever its outcome), so the caller can read the refs.
 */
export function createGitHttpHandler(options: {
  authorize: (request: GitHttpRequest) => GitHttpDecision | undefined;
  onPushed?: (repository: string) => void;
}): GitHttpHandler {
  const backend = join(
    execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
    'git-http-backend',
  );
  const running = new Set<ChildProcess>();
  return {
    handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/([^/]+)\/([^/]+?)\.git(\/.*)$/.exec(url.pathname);
      if (!match) {
        response.writeHead(404).end();
        return;
      }
      const access =
        url.searchParams.get('service') === 'git-receive-pack' ||
        url.pathname.endsWith('/git-receive-pack')
          ? 'push'
          : 'fetch';
      const decision = options.authorize({
        owner: match[1] ?? '',
        name: match[2] ?? '',
        access,
        credential: parseCredential(request.headers.authorization),
      }) ?? { status: 404, message: 'Repository not found.' };
      if ('status' in decision) {
        request.resume();
        response.writeHead(decision.status, { 'content-type': 'text/plain', ...decision.headers });
        response.end(decision.message === undefined ? '' : `${decision.message}\n`);
        return;
      }
      const cgi = spawn(backend, [], {
        env: {
          ...ISOLATED_GIT_ENV,
          ...decision.env,
          GIT_PROJECT_ROOT: dirname(decision.repository),
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/${basename(decision.repository)}${match[3] ?? ''}`,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
          GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
          REMOTE_USER: decision.user,
          REMOTE_ADDR: '127.0.0.1',
          PATH: process.env.PATH ?? '',
        },
      });
      running.add(cgi);
      request.pipe(cgi.stdin);
      let head = Buffer.alloc(0);
      let headersSent = false;
      cgi.stdout.on('data', (chunk: Buffer) => {
        if (headersSent) {
          response.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        let status = 200;
        for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
          const separator = line.indexOf(':');
          const name = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim();
          if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
          else response.setHeader(name, value);
        }
        response.writeHead(status);
        headersSent = true;
        response.write(head.subarray(end + 4));
      });
      cgi.on('close', () => {
        running.delete(cgi);
        if (access === 'push' && request.method === 'POST') {
          options.onPushed?.(decision.repository);
        }
        response.end();
      });
    },
    async close() {
      const exits = [...running].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => {
              resolve();
            });
          }),
      );
      for (const child of running) child.kill('SIGKILL');
      await Promise.all(exits);
    },
  };
}

/**
 * Serves the repositories under `root` to `username` and `password` only. `delayMs` holds each
 * request that long first, `delayPushMs` each push request, for tests that watch a command while
 * it runs.
 */
export async function startGitHttpServer(
  root: string,
  credential: { username: string; password: string },
  options: { delayMs?: number; delayPushMs?: number } = {},
): Promise<GitHttpServer> {
  const requests: GitHttpServer['requests'] = [];
  const handler = createGitHttpHandler({
    authorize: (request) => {
      const authenticated =
        request.credential?.username === credential.username &&
        request.credential.password === credential.password;
      if (!authenticated) {
        return { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } };
      }
      const repository = join(root, request.owner, `${request.name}.git`);
      // As GitHub answers for a repository that does not exist or the token cannot see.
      return existsSync(repository)
        ? { repository, user: credential.username }
        : { status: 404, message: 'Repository not found.' };
    },
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const sent = parseCredential(request.headers.authorization);
    const push =
      url.searchParams.get('service') === 'git-receive-pack' ||
      url.pathname.endsWith('/git-receive-pack');
    requests.push({
      path: url.pathname,
      authenticated:
        sent?.username === credential.username && sent.password === credential.password,
      push,
    });
    const delay = (push ? options.delayPushMs : undefined) ?? options.delayMs;
    if (delay) {
      setTimeout(() => {
        handler.handle(request, response);
      }, delay);
    } else {
      handler.handle(request, response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
