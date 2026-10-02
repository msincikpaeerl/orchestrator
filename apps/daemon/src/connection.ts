import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  DAEMON_MESSAGE_MAX_BYTES,
  DaemonCloseCode,
  ServerMessage,
  type ConnectionState,
  type DaemonMessage,
  type Hello,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { safeJson } from './config.js';
import type { StopReason } from './last-stop.js';

/**
 * Reconnection backoff (05, section 3.2): 1 s doubling up to 60 s. Constants, not settings: the
 * daemon needs them before it is connected and can read any setting.
 */
export const BACKOFF_FIRST_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;

/** The part of a `ws` WebSocket the connection uses; tests give a fake. */
export interface SocketLike {
  on(event: 'open' | 'pong', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    listener: (request: unknown, response: IncomingMessage) => void,
  ): unknown;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type SocketFactory = (url: string, token: string, ca: string | null) => SocketLike;

export const openWebSocket: SocketFactory = (url, token, ca) =>
  new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: 10_000,
    maxPayload: DAEMON_MESSAGE_MAX_BYTES,
    ...(ca ? { ca } : {}),
  });

/** A refusal that retrying cannot fix: the daemon stops (05, section 3.2). */
export interface Refusal {
  reason: Exclude<StopReason, 'stopped'>;
  message: string;
}

export interface ConnectionOptions {
  url: string;
  token: string;
  ca: string | null;
  log: Logger;
  /** The `hello` payload, built before each attempt: the checks run at each `hello`. */
  hello: () => Promise<Hello['payload']>;
  /** Called once when a refusal stops the connection. */
  onRefused: (refusal: Refusal) => void;
  /** Called after each accepted `welcome`. */
  onWelcome?: () => void;
  /** Called when a connection accepted by `welcome` is lost or closed. */
  onDisconnected?: () => void;
  /** Every other message of the server on the current connection: commands, acks, answers. */
  onMessage?: (message: Exclude<ServerMessage, { type: 'welcome' }>) => void;
  socketFactory?: SocketFactory;
}

const REENROLL =
  'On the machine\'s page in the Orchestrator, click "New enrollment code", type the enroll command it shows, then restart the daemon (systemctl --user restart orchestrator-daemon).';

/**
 * The daemon's connection to the server (05, section 3.2): `hello`, heartbeats with a WebSocket
 * ping, reconnection with backoff, and the refusals that stop it. Only events of the current
 * socket count: a socket abandoned for a newer one is ignored whatever it reports.
 */
export class ServerConnection {
  state: ConnectionState = 'waiting';
  connectedAt: Date | null = null;
  lastError: string | null = null;
  private current: SocketLike | null = null;
  /** The socket `stop()` closed, until `release()` ends it. */
  private closing: SocketLike | null = null;
  private retries = 0;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly factory: SocketFactory;

  constructor(private readonly options: ConnectionOptions) {
    this.factory = options.socketFactory ?? openWebSocket;
  }

  start(): void {
    void this.attempt();
  }

  /** Closes the connection for good (the daemon is stopping). */
  stop(): void {
    this.leave();
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    const socket = this.current;
    this.current = null;
    this.closing = socket;
    socket?.close(1000, 'daemon stopping');
  }

  /**
   * Ends the socket `stop()` closed without waiting any longer for the server's answer to the
   * close, which a server that does not answer would make last the `ws` close timeout (30 s).
   * Called once the daemon's own stopping work is done (05, section 6).
   */
  release(): void {
    this.closing?.terminate();
    this.closing = null;
  }

  /** Read through a method: `stop()` can run while an attempt awaits. */
  private isStopped(): boolean {
    return this.stopped;
  }

  /** Delay before the next attempt: 1 s, 2 s, 4 s, ... up to 60 s. */
  static backoffMs(retries: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(retries, 16));
  }

  /** Leaves the connected state, telling the daemon once. */
  private leave(): void {
    if (this.state !== 'connected') return;
    this.state = 'waiting';
    this.options.onDisconnected?.();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.leave();
    this.state = 'waiting';
    this.connectedAt = null;
    const delay = ServerConnection.backoffMs(this.retries);
    this.retries++;
    this.options.log.info({ delayMs: delay }, 'reconnecting after a delay');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.attempt(), delay);
  }

  private refuse(refusal: Refusal): void {
    if (this.stopped) return;
    this.options.log.error({ reason: refusal.reason }, refusal.message);
    this.stop();
    this.options.onRefused(refusal);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    this.state = 'connecting';
    let hello: Hello;
    try {
      hello = { type: 'hello', id: randomUUID(), payload: await this.options.hello() };
    } catch (error) {
      this.lastError = `checks failed: ${(error as Error).message}`;
      this.options.log.error({ err: error }, 'could not prepare hello');
      this.scheduleRetry();
      return;
    }
    // Stopped while `hello` was being prepared.
    if (this.isStopped()) return;
    const socket = this.factory(this.options.url, this.options.token, this.options.ca);
    this.current = socket;
    let pending = 0;

    socket.on('open', () => {
      if (socket !== this.current) return;
      this.send(socket, hello);
    });
    socket.on('unexpected-response', (_request, response) => {
      if (socket !== this.current) return;
      response.resume();
      if (response.statusCode === 401) {
        this.refuse({
          reason: 'unknown_token',
          message: `The Orchestrator does not know this machine's key (a new enrollment code was made, or the machine's key is from another Orchestrator). ${REENROLL}`,
        });
        return;
      }
      this.lastError = `the Orchestrator answered HTTP ${String(response.statusCode)}`;
      socket.terminate();
    });
    socket.on('error', (error) => {
      if (socket !== this.current) return;
      this.lastError = error.message;
      this.options.log.warn({ err: error.message }, 'connection error');
    });
    socket.on('pong', () => {
      if (socket === this.current) pending = 0;
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== this.current) return;
      const text = isBinary ? '' : Buffer.from(data as Buffer).toString('utf8');
      const parsed = ServerMessage.safeParse(safeJson(text));
      if (!parsed.success) {
        this.options.log.warn('message from the server not understood: ignored');
        return;
      }
      const message = parsed.data;
      if (message.type !== 'welcome') {
        if (this.state === 'connected') this.options.onMessage?.(message);
        return;
      }
      if (message.id !== hello.id) return;
      const welcome = message.payload;
      if (!welcome.accepted) {
        this.refuse(
          welcome.reason === 'token_revoked'
            ? {
                reason: 'revoked',
                message: `This machine was revoked in the Orchestrator. ${REENROLL}`,
              }
            : {
                reason: 'incompatible',
                message: `The Orchestrator refused this daemon's version. ${welcome.message} Then restart the daemon (systemctl --user restart orchestrator-daemon).`,
              },
        );
        return;
      }
      this.state = 'connected';
      this.connectedAt = new Date();
      this.lastError = null;
      this.retries = 0;
      this.options.log.info(
        { heartbeatIntervalSeconds: welcome.heartbeatIntervalSeconds },
        'connected to the Orchestrator',
      );
      clearInterval(this.heartbeatTimer);
      // A ping with each heartbeat; two intervals without a pong abandon the connection.
      this.heartbeatTimer = setInterval(() => {
        if (socket !== this.current) return;
        if (pending >= 2) {
          this.abandon(socket, 'no answer from the Orchestrator for two heartbeat intervals');
          return;
        }
        pending++;
        this.send(socket, { type: 'heartbeat', id: randomUUID(), payload: {} });
        socket.ping();
      }, welcome.heartbeatIntervalSeconds * 1000);
      this.options.onWelcome?.();
    });
    socket.on('close', (code, reason) => {
      if (socket !== this.current) {
        this.options.log.debug({ code }, 'close of an abandoned connection: ignored');
        return;
      }
      this.current = null;
      clearInterval(this.heartbeatTimer);
      if (this.stopped) return;
      const text = reason.toString('utf8');
      this.options.log.warn({ code, reason: text }, 'disconnected from the Orchestrator');
      switch (code) {
        case DaemonCloseCode.revoked:
          this.refuse({
            reason: 'revoked',
            message: `This machine was revoked in the Orchestrator. ${REENROLL}`,
          });
          return;
        case DaemonCloseCode.incompatible:
          this.refuse({
            reason: 'incompatible',
            message:
              "The Orchestrator refused this daemon's version. Install the daemon with the npm install -g command shown on the machine's page, then restart the daemon (systemctl --user restart orchestrator-daemon).",
          });
          return;
        case DaemonCloseCode.replaced:
          this.refuse({
            reason: 'replaced',
            message:
              "Another daemon connected with this machine's key, so this one stopped. A machine's key must be used by one daemon only: stop the other one (another terminal, or a copy of ~/.orchestrator on another computer), or enroll that computer as its own machine.",
          });
          return;
        default:
          if (this.state === 'connected' || !this.lastError) {
            this.lastError = `disconnected (${String(code)}${text ? `: ${text}` : ''})`;
          }
          this.scheduleRetry();
      }
    });
  }

  /** Drops a connection that stopped answering, and opens a new one. */
  private abandon(socket: SocketLike, why: string): void {
    this.options.log.warn(why);
    this.lastError = why;
    this.current = null;
    clearInterval(this.heartbeatTimer);
    socket.terminate();
    this.scheduleRetry();
  }

  private send(socket: SocketLike, message: DaemonMessage): void {
    socket.send(JSON.stringify(message));
  }

  /** Sends on the current connection once `welcome` accepted it; false otherwise. */
  sendMessage(message: DaemonMessage): boolean {
    const socket = this.current;
    if (!socket || this.state !== 'connected') return false;
    this.send(socket, message);
    return true;
  }
}
