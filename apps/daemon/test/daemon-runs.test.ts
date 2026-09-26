import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  DaemonMessage,
  PROTOCOL_VERSION,
  type Hello,
  type RunState,
  type ServerMessage,
} from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { writeConfig } from '../src/config.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { createRemote } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  createTestHome,
  linkSystemTool,
  runDaemon,
  spawnDaemon,
  waitFor,
  type DaemonProcess,
  type TestHome,
} from './testing.js';

// The daemon process with its runs, against a scripted server on the WebSocket (the server's
// side comes in plan step J): run.start, the Git credential asked for the fetch, reports
// acknowledged or resent, and a restart that finds the session again.

const TIMEOUT = 90_000;
const TOKEN = 'ghp_ScriptedServerToken0123456789abcdefgh';

/** A server speaking the daemon protocol: welcomes, records, acknowledges when told to. */
class ScriptedServer {
  received: DaemonMessage[] = [];
  acknowledge = true;
  private socket: WebSocket | null = null;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  url = '';

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, path: '/daemon' });
    this.wss.on('connection', (socket) => {
      this.socket = socket;
      socket.on('message', (data: Buffer) => {
        const message = DaemonMessage.parse(JSON.parse(data.toString('utf8')));
        this.received.push(message);
        this.answer(socket, message);
      });
    });
  }

  private answer(socket: WebSocket, message: DaemonMessage): void {
    const send = (answer: ServerMessage) => {
      socket.send(JSON.stringify(answer));
    };
    switch (message.type) {
      case 'hello':
        send({
          type: 'welcome',
          id: message.id,
          payload: {
            accepted: true,
            protocolVersion: PROTOCOL_VERSION,
            heartbeatIntervalSeconds: 5,
          },
        });
        return;
      case 'git.credential_request':
        send({
          type: 'git.credential',
          id: message.id,
          payload: { ok: true, username: 'x-access-token', password: TOKEN },
        });
        return;
      case 'run.state':
      case 'run.events':
      case 'run.quota_limited':
        if (this.acknowledge) send({ type: 'ack', id: message.id, payload: { ok: true } });
        return;
      default:
    }
  }

  send(message: ServerMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.http.address() as AddressInfo).port)}`;
  }

  hellos(): Hello[] {
    return this.received.filter((message): message is Hello => message.type === 'hello');
  }

  states(runId: string): RunState[] {
    return this.received.filter(
      (message): message is RunState =>
        message.type === 'run.state' && message.payload.runId === runId,
    );
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise((resolve) => this.http.close(resolve));
  }
}

let home: TestHome;
let fake: FakeClaude;
let server: ScriptedServer;
let git: GitHttpServer;
let daemons: DaemonProcess[];

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  await linkSystemTool(home.bin, 'tmux');
  fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
  const tmuxDir = join(home.root, 'tmux');
  await mkdir(tmuxDir, { mode: 0o700 });
  home.env.TMUX_TMPDIR = tmuxDir;
  home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
  const remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'owner', 'notes', home.env);
  git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
  server = new ScriptedServer();
  await server.listen();
  await writeConfig(home.paths.config, {
    serverUrl: server.url,
    machineId: randomUUID(),
    machineName: 'Desktop',
    machineToken: `omt_${'d'.repeat(43)}`,
    ca: null,
  });
  daemons = [];
});
afterEach(async () => {
  for (const daemon of daemons) {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  }
  spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], { env: home.env });
  await server.close();
  await git.close();
  await home.remove();
});

function startDaemon(): DaemonProcess {
  const daemon = spawnDaemon(['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

describe('daemon runs over the connection', () => {
  it(
    'runs a ticket, asks the server for the Git credential, and finds the session after a restart',
    async () => {
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'sleep', ms: 8000 },
              { do: 'text', text: 'Done.' },
            ],
          },
        ],
      });
      const first = startDaemon();
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      expect(server.hellos()[0]?.payload.runs).toEqual([]);

      const payload = runStartPayload(`${git.url}/owner/notes.git`, {
        limits: { maxNudgesPerRun: 0 },
      });
      // Reports stay unacknowledged until the restart.
      server.acknowledge = false;
      const startId = randomUUID();
      server.send({ type: 'run.start', id: startId, payload });
      await waitFor(
        () =>
          server.received.some(
            (message) => message.type === 'ack' && message.id === startId && message.payload.ok,
          ),
        10_000,
        'the ack of run.start',
      );
      await waitFor(
        () => server.states(payload.runId).some((state) => state.payload.state === 'working'),
        30_000,
        'the working state',
      );
      expect(
        server.received.filter((message) => message.type === 'git.credential_request'),
      ).toMatchObject([{ payload: { runId: payload.runId, command: 'fetch' } }]);
      expect(git.requests.some((request) => request.authenticated)).toBe(true);

      const status = await runDaemon(['status'], home.env);
      expect(status.stdout).toContain(`${payload.runId} (working)`);

      // Stopped while the agent works: the session goes on, the next daemon finds it.
      first.child.kill('SIGTERM');
      expect(await first.exited).toBe(0);
      const before = server.received.length;
      startDaemon();
      await waitFor(() => server.hellos().length === 2, 20_000, 'the second hello');
      expect(server.hellos()[1]?.payload.runs).toEqual([
        { runId: payload.runId, state: 'working', claudeSessionId: expect.any(String) as unknown },
      ]);
      server.acknowledge = true;
      const delivered = server.states(payload.runId).slice(0, 3);
      expect(delivered.map((state) => state.payload.state)).toEqual([
        'preparing',
        'starting',
        'working',
      ]);
      // Reports sent before the restart and never acknowledged come again, in order, same ids.
      await waitFor(
        () =>
          delivered.every((report) =>
            server.received.slice(before).some((message) => message.id === report.id),
          ),
        10_000,
        'the reports sent again',
      );
      const again = server.received.slice(before).map((message) => message.id);
      expect(delivered.map((report) => again.indexOf(report.id))).toEqual(
        [...delivered.map((report) => again.indexOf(report.id))].sort((a, b) => a - b),
      );

      const end = await (async () => {
        await waitFor(
          () => server.states(payload.runId).some((state) => state.payload.state === 'ended'),
          30_000,
          'the end of the run',
        );
        return server.states(payload.runId).at(-1)?.payload;
      })();
      expect(end).toMatchObject({ state: 'ended', reason: 'nudges_exhausted' });
    },
    TIMEOUT,
  );
});
