import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

// A local Git HTTP remote asking for Basic authentication (ADR 0027): `git http-backend` behind
// a small server, so credential tests use Git's real HTTP client and credential helpers.

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** Requests received: whether each carried the right credential. */
  requests: { path: string; authenticated: boolean }[];
  close(): Promise<void>;
}

/** Serves the repositories under `root` to `username` and `password` only. */
export async function startGitHttpServer(
  root: string,
  credential: { username: string; password: string },
): Promise<GitHttpServer> {
  const backend = join(
    execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
    'git-http-backend',
  );
  const expected = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
  const requests: GitHttpServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const authenticated = request.headers.authorization === expected;
    requests.push({ path: url.pathname, authenticated });
    if (!authenticated) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      response.end();
      return;
    }
    const cgi = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
        REMOTE_USER: credential.username,
        REMOTE_ADDR: '127.0.0.1',
        PATH: process.env.PATH ?? '',
      },
    });
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
    cgi.on('close', () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
