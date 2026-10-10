import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubUnreachableError, createGitHubClient, mayHaveArrived } from './client.js';

// A request that never left is told apart from an answer lost after it left (lot 3 step H3): only
// the first may be called "not posted".

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function failure(apiUrl: string, timeoutSeconds = 5): Promise<GitHubUnreachableError> {
  const client = createGitHubClient({ apiUrl, token: 'test-token', timeoutSeconds });
  const error: unknown = await client
    .request({ method: 'POST', path: '/x', body: {} })
    .catch((caught: unknown) => caught);
  if (!(error instanceof GitHubUnreachableError)) throw new Error('no GitHubUnreachableError');
  return error;
}

describe('GitHubUnreachableError.sent', () => {
  it('false when no connection could be made', async () => {
    const url = await listen(() => undefined);
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = undefined;
    expect((await failure(url)).sent).toBe(false);
  });

  it('true for a timeout, a connection cut and a server error', async () => {
    let mode: 'silent' | 'cut' | 'error' = 'silent';
    const url = await listen((_request, response) => {
      if (mode === 'cut') response.socket?.destroy();
      if (mode === 'error') response.writeHead(502).end();
    });
    expect((await failure(url, 1)).sent).toBe(true);
    mode = 'cut';
    expect((await failure(url)).sent).toBe(true);
    mode = 'error';
    expect((await failure(url)).sent).toBe(true);
  });

  it('reads the cause of fetch', () => {
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(mayHaveArrived(refused)).toBe(false);
    expect(mayHaveArrived(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBe(
      true,
    );
    expect(mayHaveArrived(new Error('anything'))).toBe(true);
  });
});
