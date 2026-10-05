import { randomUUID } from 'node:crypto';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  DAEMON_SOCKET_PATH,
  EnrollResponse,
  PROTOCOL_VERSION,
  ServerMessage,
  type DaemonMessage,
  type Hello,
} from '@orchestrator/protocol';
import WebSocket from 'ws';

// A scripted daemon for tests (lot 2 step C): it enrolls, connects, says `hello` and sends what a
// test tells it to, so the server's gateway is tested without the real daemon.

/** A `hello` of a healthy machine, with the fields to change. */
export function helloMessage(payload: Partial<Hello['payload']> = {}): Hello {
  return {
    type: 'hello',
    id: randomUUID(),
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: '0.3.0',
      // A daemon run from its sources: the test servers serve no built package.
      daemonBuild: null,
      claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION,
      os: 'wsl',
      capabilities: ['git', 'node'],
      doctor: [{ name: 'git', status: 'ok', message: 'git 2.53.0', link: null }],
      runs: [],
      ...payload,
    },
  };
}

/** `POST /daemon/enroll` as `orchestrator-daemon enroll` sends it; the status and the body. */
export async function enroll(
  serverUrl: string,
  code: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${serverUrl}/daemon/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { status: response.status, body: await response.json() };
}

/** Enrolls with a code that must work, and returns the machine token. */
export async function enrollToken(serverUrl: string, code: string): Promise<string> {
  const { status, body } = await enroll(serverUrl, code);
  if (status !== 200)
    throw new Error(`enrollment failed: ${String(status)} ${JSON.stringify(body)}`);
  return EnrollResponse.parse(body).machineToken;
}

export interface Closed {
  code: number;
  reason: string;
}

export class ScriptedDaemon {
  /** Every message received from the server, in order, validated with its schema. */
  readonly received: ServerMessage[] = [];
  /** Resolves when the connection closes, with the close code the server gave. */
  readonly closed: Promise<Closed>;
  /** Called with each message received, after it is recorded (the e2e server acknowledges). */
  onMessage: ((message: ServerMessage) => void) | undefined;
  private waiters: (() => void)[] = [];

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
        this.wake();
      });
    });
    socket.on('message', (data: Buffer) => {
      const message = ServerMessage.parse(JSON.parse(data.toString('utf8')));
      this.received.push(message);
      this.wake();
      this.onMessage?.(message);
    });
  }

  /**
   * Opens the daemon's WebSocket with the machine token. Rejects with the HTTP status when the
   * server refuses before the WebSocket opens.
   */
  static connect(serverUrl: string, token: string): Promise<ScriptedDaemon> {
    const url = `${serverUrl.replace(/^http/, 'ws')}${DAEMON_SOCKET_PATH}`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        resolve(new ScriptedDaemon(socket));
      });
      socket.once('unexpected-response', (_request, response) => {
        reject(new RefusedConnection(response.statusCode ?? 0));
      });
      socket.once('error', reject);
    });
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  send(message: DaemonMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** Waits for the first message received with this type (up to `timeoutMs`). */
  async next<Type extends ServerMessage['type']>(
    type: Type,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { type: Type }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(
        (message): message is Extract<ServerMessage, { type: Type }> => message.type === type,
      );
      if (found) return found;
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`closed before ${type}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} within ${String(timeoutMs)} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits for the first message received that `match` accepts (up to `timeoutMs`). */
  async find<T extends ServerMessage = ServerMessage>(
    match: (message: ServerMessage) => boolean,
    what: string,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(match);
      if (found) return found as T;
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`closed before ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${what} within ${String(timeoutMs)} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * Sends a report or request and returns the server's answer with the same id: `ack`,
   * `mcp.result` or `git.credential`.
   */
  async request(message: DaemonMessage): Promise<ServerMessage> {
    this.send(message);
    return this.find(
      (received) => received.id === message.id && received.type !== 'welcome',
      `answer to ${message.type}`,
    );
  }

  /** Sends `hello` and returns the server's `welcome`. */
  async hello(payload: Partial<Hello['payload']> = {}) {
    const message = helloMessage(payload);
    this.send(message);
    const welcome = await this.next('welcome');
    if (welcome.id !== message.id) throw new Error('welcome answers another message');
    return welcome.payload;
  }

  heartbeat(): void {
    this.send({ type: 'heartbeat', id: randomUUID(), payload: {} });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async close(): Promise<Closed> {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close(1000, 'test done');
    return this.closed;
  }
}

/** The server refused the WebSocket before it opened, with this HTTP status. */
export class RefusedConnection extends Error {
  constructor(readonly status: number) {
    super(`connection refused: HTTP ${String(status)}`);
  }
}
