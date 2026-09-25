import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { ControlRequest, ControlStatus } from '@orchestrator/protocol';
import { safeJson } from './config.js';

// The control socket `~/.orchestrator/daemon.sock` (05, section 8). Read-only: its only request
// is `status`, which changes nothing, and its answer never holds a token or another secret,
// because agents run under the same user as the daemon.

/** Longest request line read, far above `{"type":"status"}`. */
const MAX_REQUEST_BYTES = 1024;

/** Starts answering on `path`, which must not exist (see `probeControl`). */
export async function serveControl(path: string, status: () => ControlStatus): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = ControlRequest.safeParse(safeJson(buffer.slice(0, end)));
      socket.end(
        `${JSON.stringify(request.success ? status() : { type: 'error', message: 'unknown request' })}\n`,
      );
    });
    socket.on('error', () => {
      // The client went away: nothing to answer.
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return server;
}

export type ControlProbe =
  | { kind: 'running'; status: ControlStatus }
  /** No socket file. */
  | { kind: 'absent' }
  /** A socket file where nothing answers: left by a daemon that crashed. */
  | { kind: 'stale' };

/** Asks the daemon on `path` for its status. */
export function probeControl(path: string, timeoutMs = 3000): Promise<ControlProbe> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let answer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ kind: 'stale' });
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'status' } satisfies ControlRequest)}\n`);
    });
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const status = ControlStatus.safeParse(safeJson(answer.trim()));
      resolve(status.success ? { kind: 'running', status: status.data } : { kind: 'stale' });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'stale' });
    });
  });
}

/** Removes a stale socket file so a new daemon can listen (05, section 8). */
export async function removeStaleControl(path: string): Promise<void> {
  await rm(path, { force: true });
}
