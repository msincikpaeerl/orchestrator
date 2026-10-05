import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { ControlStatus } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeControl, removeStaleControl, serveControl } from '../src/control.js';
import { createTestHome, type TestHome } from './testing.js';

let home: TestHome;
beforeEach(async () => {
  home = await createTestHome();
  await mkdir(home.paths.home, { recursive: true });
});
afterEach(async () => {
  await home.remove();
});

const status: ControlStatus = {
  type: 'status',
  mode: 'service',
  pid: 1234,
  startedAt: '2026-09-26T08:00:00.000Z',
  serverUrl: 'http://localhost:8080',
  machineName: 'Desktop',
  connection: 'connected',
  connectedAt: '2026-09-26T08:00:01.000Z',
  lastError: null,
  daemonVersion: '0.2.0',
  daemonBuild: '0123456789abcdef',
  protocolVersion: 1,
  claudeCodeVersion: '2.1.282',
  os: 'wsl',
  capabilities: ['git'],
  processScopes: {
    name: 'Process scopes',
    status: 'ok',
    message: "Used: agents' sessions keep running when the service restarts",
    link: null,
  },
  runs: [],
};

/** Sends raw text on the socket and returns everything answered. */
function raw(path: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => socket.write(text));
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (answer += chunk));
    socket.on('close', () => {
      resolve(answer);
    });
    socket.on('error', reject);
  });
}

describe('the control socket (05, section 8)', () => {
  it('answers status, readable by the owner only', async () => {
    const server = await serveControl(home.paths.controlSocket, () => status);
    try {
      expect(await probeControl(home.paths.controlSocket)).toEqual({ kind: 'running', status });
      expect((await stat(home.paths.controlSocket)).mode & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
  });

  it('is read-only: anything but status is refused', async () => {
    const server = await serveControl(home.paths.controlSocket, () => status);
    try {
      expect(JSON.parse(await raw(home.paths.controlSocket, '{"type":"stop"}\n'))).toEqual({
        type: 'error',
        message: 'unknown request',
      });
      expect(await raw(home.paths.controlSocket, 'x'.repeat(5000))).toBe('');
    } finally {
      server.close();
    }
  });

  it('tells a missing socket from one where nothing answers', async () => {
    expect(await probeControl(home.paths.controlSocket)).toEqual({ kind: 'absent' });
    // What a crash leaves: the file, and no daemon behind it.
    await writeFile(home.paths.controlSocket, '');
    expect(await probeControl(home.paths.controlSocket)).toEqual({ kind: 'stale' });
    await removeStaleControl(home.paths.controlSocket);
    const server = await serveControl(home.paths.controlSocket, () => status);
    server.close();
  });
});
