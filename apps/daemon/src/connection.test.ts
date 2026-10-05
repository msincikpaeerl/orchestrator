import { EventEmitter } from 'node:events';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  DaemonCloseCode,
  DaemonMessage,
  PROTOCOL_VERSION,
  type Hello,
  type ServerMessage,
} from '@orchestrator/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerConnection, type Refusal, type SocketLike } from './connection.js';

/** A socket the test drives: it records what the daemon sends and emits what the server does. */
class FakeSocket extends EventEmitter implements SocketLike {
  sent: DaemonMessage[] = [];
  pings = 0;
  closed: number | null = null;
  terminated = false;

  send(data: string) {
    this.sent.push(DaemonMessage.parse(JSON.parse(data)));
  }
  ping() {
    this.pings++;
  }
  close(code = 1005) {
    this.closed = code;
  }
  terminate() {
    this.terminated = true;
  }

  get hello(): Hello {
    const hello = this.sent.find((message) => message.type === 'hello');
    if (!hello) throw new Error('no hello sent');
    return hello;
  }
  receive(message: ServerMessage) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  welcome(heartbeatIntervalSeconds = 15) {
    this.receive({
      type: 'welcome',
      id: this.hello.id,
      payload: { accepted: true, protocolVersion: PROTOCOL_VERSION, heartbeatIntervalSeconds },
    });
  }
  serverClose(code: number, reason = '') {
    this.emit('close', code, Buffer.from(reason));
  }
}

const payload: Hello['payload'] = {
  protocolVersion: PROTOCOL_VERSION,
  daemonVersion: '0.2.0',
  daemonBuild: null,
  claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION,
  os: 'linux',
  capabilities: ['git'],
  doctor: [],
  runs: [],
};

let sockets: FakeSocket[];
let refusals: Refusal[];
let received: ServerMessage[];
let connection: ServerConnection;

/** Lets the promise work of an attempt (building `hello`) run. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

async function open(): Promise<FakeSocket> {
  await settle();
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket opened');
  socket.emit('open');
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  refusals = [];
  received = [];
  connection = new ServerConnection({
    url: 'ws://localhost:8080/daemon',
    token: `omt_${'a'.repeat(43)}`,
    ca: null,
    log: pino({ level: 'silent' }),
    hello: () => Promise.resolve(payload),
    onRefused: (refusal) => refusals.push(refusal),
    onMessage: (message) => received.push(message),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  connection.start();
});

afterEach(() => {
  connection.stop();
  vi.useRealTimers();
});

describe('the daemon connection (05, section 3.2)', () => {
  it("passes the server's messages on and sends reports only once welcomed", async () => {
    const socket = await open();
    const ack: ServerMessage = {
      type: 'ack',
      id: '0b6f2f7e-3c1a-4d5e-9f8a-1b2c3d4e5f60',
      payload: { ok: true },
    };
    const heartbeat: DaemonMessage = {
      type: 'heartbeat',
      id: '1b6f2f7e-3c1a-4d5e-9f8a-1b2c3d4e5f60',
      payload: {},
    };
    socket.receive(ack);
    expect(received).toEqual([]);
    expect(connection.sendMessage(heartbeat)).toBe(false);
    socket.welcome();
    socket.receive(ack);
    expect(received).toEqual([ack]);
    expect(connection.sendMessage(heartbeat)).toBe(true);
    expect(socket.sent.at(-1)).toEqual(heartbeat);
  });

  it('says hello first, then sends a heartbeat and a ping at each interval', async () => {
    const socket = await open();
    expect(socket.sent.map((message) => message.type)).toEqual(['hello']);
    expect(socket.hello.payload).toEqual(payload);
    socket.welcome(15);
    expect(connection.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent.map((message) => message.type)).toEqual(['hello', 'heartbeat']);
    expect(socket.pings).toBe(1);
  });

  it('reconnects with a backoff of 1 s doubling up to 60 s, reset once welcomed', async () => {
    expect([0, 1, 2, 5, 6, 7, 30].map((retries) => ServerConnection.backoffMs(retries))).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000,
    ]);
    (await open()).serverClose(1006);
    expect(connection.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    (await open()).serverClose(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = await open();
    third.welcome();
    third.serverClose(DaemonCloseCode.shutdown, 'server shutting down');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(4);
    expect(refusals).toEqual([]);
  });

  it('abandons a connection without a pong for two intervals, and opens a new one', async () => {
    const socket = await open();
    socket.welcome(10);
    await vi.advanceTimersByTimeAsync(10_000);
    socket.emit('pong');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.terminated).toBe(true);
    expect(connection.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it('ignores "replaced" on a connection it abandoned, and stops on "replaced" on the current one', async () => {
    const first = await open();
    first.welcome(10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const second = await open();
    second.welcome(10);

    // The server accepted the new connection and closed the old one as replaced.
    first.serverClose(DaemonCloseCode.replaced, 'replaced by a newer connection');
    expect(refusals).toEqual([]);
    expect(connection.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets).toHaveLength(2);
    expect(second.terminated).toBe(false);

    // Now another daemon takes this machine's connection.
    second.serverClose(DaemonCloseCode.replaced, 'replaced by a newer connection');
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['replaced']);
    expect(refusals[0]?.message).toMatch(/Another daemon connected with this machine's key/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2);
  });

  it('stops on an unknown token (HTTP 401), saying how to enroll again', async () => {
    await settle();
    const socket = sockets[0];
    socket?.emit(
      'unexpected-response',
      {},
      Object.assign(new EventEmitter(), {
        statusCode: 401,
        resume: () => undefined,
      }),
    );
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['unknown_token']);
    expect(refusals[0]?.message).toMatch(/New enrollment code/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('retries after another HTTP refusal of the WebSocket', async () => {
    await settle();
    const socket = sockets[0];
    socket?.emit(
      'unexpected-response',
      {},
      {
        statusCode: 502,
        resume: () => undefined,
      },
    );
    expect(socket?.terminated).toBe(true);
    socket?.serverClose(1006);
    expect(connection.lastError).toMatch(/HTTP 502/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(refusals).toEqual([]);
  });

  it('stops on a revoked token, from welcome or from the close code', async () => {
    const socket = await open();
    socket.receive({
      type: 'welcome',
      id: socket.hello.id,
      payload: { accepted: false, reason: 'token_revoked', message: 'revoked' },
    });
    socket.serverClose(DaemonCloseCode.revoked, 'token revoked');
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['revoked']);
    expect(refusals[0]?.message).toMatch(/revoked in the Orchestrator.*enroll command/);
  });

  it("stops on an incompatible protocol with the server's instruction", async () => {
    const socket = await open();
    socket.receive({
      type: 'welcome',
      id: socket.hello.id,
      payload: {
        accepted: false,
        reason: 'protocol_incompatible',
        message:
          "Install the daemon of the server's version: npm install -g http://localhost:8080/downloads/orchestrator-daemon-0.3.0.tgz",
      },
    });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['incompatible']);
    expect(refusals[0]?.message).toContain('orchestrator-daemon-0.3.0.tgz');
  });

  it('stops on the revoked and incompatible close codes without a welcome', async () => {
    (await open()).serverClose(DaemonCloseCode.incompatible);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['incompatible']);
  });

  it('keeps retrying after a silent close and ignores a welcome answering another hello', async () => {
    const socket = await open();
    socket.receive({
      type: 'welcome',
      id: '00000000-0000-4000-8000-000000000000',
      payload: { accepted: true, protocolVersion: PROTOCOL_VERSION, heartbeatIntervalSeconds: 15 },
    });
    expect(connection.state).toBe('connecting');
    socket.serverClose(DaemonCloseCode.silent, 'nothing received in time');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(refusals).toEqual([]);
  });

  it('closes normally when the daemon stops, and never reconnects', async () => {
    const socket = await open();
    socket.welcome();
    connection.stop();
    expect(socket.closed).toBe(1000);
    socket.serverClose(1000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it("ends the closed socket on release, without waiting for the server's answer", async () => {
    const socket = await open();
    socket.welcome();
    connection.stop();
    expect(socket.terminated).toBe(false);
    connection.release();
    expect(socket.terminated).toBe(true);
  });
});
