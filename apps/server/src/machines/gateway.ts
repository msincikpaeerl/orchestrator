import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_MIN_VERSION,
  DAEMON_SOCKET_PATH,
  DaemonCloseCode,
  DaemonMessage,
  PROTOCOL_VERSION,
  claudeCodeSupport,
  isCompatibleProtocol,
  type Hello,
  type ServerMessage,
} from '@orchestrator/protocol';
import websocket from '@fastify/websocket';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { resolveSettings } from '../settings/store.js';
import { hashCredential } from './credentials.js';
import { daemonInstallCommand, doctorErrors, type MachineRow } from './model.js';

/** The protocol versions the server accepts, for the refusal message: `1`, or `1 or 2`. */
const acceptedProtocols = [PROTOCOL_VERSION - 1, PROTOCOL_VERSION]
  .filter(isCompatibleProtocol)
  .join(' or ');

type OfflineReason = 'connection_closed' | 'silent' | 'server_restarted' | 'revoked';

/** One open WebSocket of a daemon. */
interface Connection {
  socket: WebSocket;
  machineId: string;
  machineName: string;
  /** Set once `welcome` accepted it; until then it only waits for `hello`. */
  welcomed: boolean;
  /** Heartbeat interval sent in its `welcome`: its silence limit is never below twice this. */
  heartbeatIntervalSeconds: number;
  timer: NodeJS.Timeout | undefined;
  /** Closed by the server for a reason that already set the machine's status, or replaced. */
  ended: boolean;
  /** The socket closed, whoever closed it. */
  closed: boolean;
}

export interface GatewayOptions {
  db: Database;
  log: FastifyBaseLogger;
  publicUrl: string;
  /** Milliseconds in one second of the heartbeat and offline settings; tests shorten it. */
  secondMs?: number;
}

/**
 * Marks the machine offline and writes `machine.offline`, if it was online. Returns whether it
 * changed, so a machine never goes offline twice.
 */
export async function markOffline(
  db: Executor,
  machine: Pick<MachineRow, 'id' | 'name'>,
  reason: OfflineReason,
): Promise<boolean> {
  const updated = await db
    .update(schema.machines)
    .set({ status: 'offline', updatedAt: new Date() })
    .where(and(eq(schema.machines.id, machine.id), eq(schema.machines.status, 'online')))
    .returning({ id: schema.machines.id, name: schema.machines.name });
  const [row] = updated;
  if (!row) return false;
  await recordEvent(db, {
    actor: 'system',
    entityType: 'machine',
    entityId: row.id,
    type: 'machine.offline',
    payload: { name: row.name, reason },
  });
  return true;
}

/**
 * At server start no daemon is connected: machines still recorded online become offline, each
 * with its event (05, section 3.2). Returns how many.
 */
export async function markAllOffline(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const online = await tx
      .select({ id: schema.machines.id, name: schema.machines.name })
      .from(schema.machines)
      .where(eq(schema.machines.status, 'online'));
    let count = 0;
    for (const machine of online) {
      if (await markOffline(tx, machine, 'server_restarted')) count++;
    }
    return count;
  });
}

/**
 * The daemon gateway (05, section 3.2; 09, section 4): one WebSocket per connected machine,
 * authenticated by its token, with `hello`/`welcome`, heartbeats and offline detection. Run
 * messages are handled from step J on.
 */
export class DaemonGateway {
  private readonly connections = new Map<string, Connection>();
  /** Work on one machine's status runs one at a time, in order of arrival. */
  private readonly queues = new Map<string, Promise<void>>();
  private closing = false;
  private readonly db: Database;
  private readonly log: FastifyBaseLogger;
  private readonly secondMs: number;

  constructor(private readonly options: GatewayOptions) {
    this.db = options.db;
    this.log = options.log;
    this.secondMs = options.secondMs ?? 1000;
  }

  /** Registers the WebSocket plugin and the `/daemon` route. */
  register(app: FastifyInstance): void {
    void app.register(websocket, {
      options: { maxPayload: 1024 * 1024 },
      preClose: (done) => {
        this.closing = true;
        for (const connection of this.connections.values()) {
          this.end(connection, DaemonCloseCode.shutdown, 'server shutting down');
        }
        done();
      },
    });
    void app.register((scope, _options, done) => {
      scope.get(
        DAEMON_SOCKET_PATH,
        {
          websocket: true,
          // Before the WebSocket opens: an unknown token gets HTTP 401 (05, section 3.2).
          preValidation: async (request, reply) => {
            const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
            const machine = token ? await this.findByToken(token) : undefined;
            if (!machine) {
              request.log.warn('daemon connection refused: unknown token');
              return reply.code(401).send({
                error: { code: 'not_authenticated', message: 'Unknown machine token' },
              });
            }
            request.machine = { id: machine.id, name: machine.name };
          },
        },
        (socket, request) => {
          if (!request.machine) {
            socket.close(DaemonCloseCode.revoked, 'not authenticated');
            return;
          }
          this.open(socket, request.machine);
        },
      );
      done();
    });
  }

  /**
   * Closes the machine's connection, if any, after its status was already set (revocation). The
   * close does not mark it offline again.
   */
  disconnect(machineId: string, code: DaemonCloseCode, reason: string): void {
    const connection = this.connections.get(machineId);
    if (connection) this.end(connection, code, reason);
  }

  private async findByToken(token: string): Promise<MachineRow | undefined> {
    const [machine] = await this.db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.tokenHash, hashCredential(token)));
    return machine;
  }

  /** Runs `work` after the machine's earlier work, so status changes never cross. */
  private serial(machineId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(machineId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      this.log.error({ err: error, machine: machineId }, 'daemon gateway failed');
    });
    this.queues.set(machineId, next);
    void next.then(() => {
      if (this.queues.get(machineId) === next) this.queues.delete(machineId);
    });
    return next;
  }

  private open(socket: WebSocket, machine: { id: string; name: string }): void {
    const connection: Connection = {
      socket,
      machineId: machine.id,
      machineName: machine.name,
      welcomed: false,
      heartbeatIntervalSeconds: 0,
      timer: undefined,
      ended: false,
      closed: false,
    };
    const log = this.log.child({ machine: machine.name });
    log.info('daemon connected, waiting for hello');
    void this.watchSilence(connection);

    socket.on('message', (data, isBinary) => {
      void this.watchSilence(connection);
      let message: DaemonMessage;
      try {
        if (isBinary) throw new Error('binary message');
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8');
        message = DaemonMessage.parse(JSON.parse(text));
      } catch {
        log.warn('invalid message from daemon: connection closed');
        this.end(connection, DaemonCloseCode.invalidMessage, 'invalid message');
        return;
      }
      void this.serial(machine.id, () => this.handle(connection, message, log));
    });

    socket.on('close', () => {
      connection.closed = true;
      clearTimeout(connection.timer);
      if (connection.ended || this.closing) return;
      void this.serial(machine.id, async () => {
        const current = this.connections.get(machine.id);
        // A newer connection was accepted in the meantime: it keeps the machine online.
        if (current !== undefined && current !== connection) return;
        this.connections.delete(machine.id);
        if (!connection.welcomed || this.closing) return;
        log.info('daemon disconnected');
        await markOffline(this.db, machine, 'connection_closed');
      });
    });
  }

  /**
   * (Re)starts the silence timer: no `hello` or no message at all within "Machine offline after"
   * (never below twice the connection's heartbeat interval) marks the machine offline and closes.
   */
  private async watchSilence(connection: Connection): Promise<void> {
    const { machineOfflineAfterSeconds } = await resolveSettings(this.db, [
      'machineOfflineAfterSeconds',
    ]);
    if (connection.ended) return;
    const seconds = Math.max(machineOfflineAfterSeconds, 2 * connection.heartbeatIntervalSeconds);
    clearTimeout(connection.timer);
    connection.timer = setTimeout(() => {
      void this.serial(connection.machineId, async () => {
        if (connection.ended) return;
        this.log.warn(
          { machine: connection.machineName, seconds },
          connection.welcomed ? 'daemon silent: machine offline' : 'no hello from daemon',
        );
        this.end(connection, DaemonCloseCode.silent, 'nothing received in time');
        if (connection.welcomed && !this.connections.has(connection.machineId)) {
          await markOffline(
            this.db,
            { id: connection.machineId, name: connection.machineName },
            'silent',
          );
        }
      });
    }, seconds * this.secondMs);
  }

  /** Closes a connection the server ends; its close never marks the machine offline itself. */
  private end(connection: Connection, code: DaemonCloseCode, reason: string): void {
    connection.ended = true;
    clearTimeout(connection.timer);
    if (this.connections.get(connection.machineId) === connection) {
      this.connections.delete(connection.machineId);
    }
    connection.socket.close(code, reason);
  }

  private send(connection: Connection, message: ServerMessage): void {
    connection.socket.send(JSON.stringify(message));
  }

  private async handle(
    connection: Connection,
    message: DaemonMessage,
    log: FastifyBaseLogger,
  ): Promise<void> {
    if (connection.ended) return;
    if (!connection.welcomed) {
      if (message.type !== 'hello') {
        log.warn({ type: message.type }, 'message before hello: connection closed');
        this.end(connection, DaemonCloseCode.invalidMessage, 'hello expected first');
        return;
      }
      await this.hello(connection, message, log);
      return;
    }
    await this.db
      .update(schema.machines)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.machines.id, connection.machineId));
    if (message.type === 'heartbeat') return;
    // Run, MCP and Git messages are handled from lot 2 step J on.
    log.warn({ type: message.type }, 'daemon message not handled by this server version');
  }

  private refuseRevoked(connection: Connection, hello: Hello, log: FastifyBaseLogger): void {
    log.warn('hello with a revoked token: connection closed');
    this.send(connection, {
      type: 'welcome',
      id: hello.id,
      payload: {
        accepted: false,
        reason: 'token_revoked',
        message:
          'This machine was revoked in the Orchestrator. To use it again, choose New enrollment code on its page and run orchestrator-daemon enroll with the new code.',
      },
    });
    this.end(connection, DaemonCloseCode.revoked, 'token revoked');
  }

  private async hello(connection: Connection, hello: Hello, log: FastifyBaseLogger) {
    const { payload } = hello;
    const [machine] = await this.db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, connection.machineId));
    if (!machine || machine.revokedAt || machine.tokenHash === null) {
      this.refuseRevoked(connection, hello, log);
      return;
    }

    const now = new Date();
    if (!isCompatibleProtocol(payload.protocolVersion)) {
      await this.db.transaction(async (tx) => {
        const changed =
          machine.daemonIncompatibleSince === null ||
          machine.daemonVersion !== payload.daemonVersion ||
          machine.protocolVersion !== payload.protocolVersion;
        await tx
          .update(schema.machines)
          .set({
            daemonVersion: payload.daemonVersion,
            protocolVersion: payload.protocolVersion,
            daemonIncompatibleSince: machine.daemonIncompatibleSince ?? now,
            updatedAt: now,
          })
          .where(eq(schema.machines.id, machine.id));
        if (changed) {
          await recordEvent(tx, {
            actor: 'system',
            entityType: 'machine',
            entityId: machine.id,
            type: 'machine.daemon_incompatible',
            payload: {
              name: machine.name,
              daemonVersion: payload.daemonVersion,
              protocolVersion: payload.protocolVersion,
            },
          });
        }
      });
      log.warn(
        { daemonVersion: payload.daemonVersion, protocolVersion: payload.protocolVersion },
        'daemon protocol not compatible: connection closed',
      );
      this.send(connection, {
        type: 'welcome',
        id: hello.id,
        payload: {
          accepted: false,
          reason: 'protocol_incompatible',
          message: `This daemon speaks protocol version ${String(payload.protocolVersion)}; this server accepts version ${acceptedProtocols}. Install the daemon of the server's version: ${daemonInstallCommand(this.options.publicUrl)}`,
        },
      });
      this.end(connection, DaemonCloseCode.incompatible, 'protocol not compatible');
      return;
    }

    const { heartbeatIntervalSeconds } = await resolveSettings(this.db, [
      'heartbeatIntervalSeconds',
    ]);
    const support = claudeCodeSupport(payload.claudeCodeVersion);
    const claudeCodeUnsupported = support === 'missing' || support === 'below_minimum';
    const doctorError = doctorErrors(payload.doctor).length > 0;
    const detected = [...new Set(payload.capabilities)].sort();

    const accepted = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.machines)
        .set({
          status: 'online',
          os: payload.os,
          daemonVersion: payload.daemonVersion,
          protocolVersion: payload.protocolVersion,
          claudeCodeVersion: payload.claudeCodeVersion,
          doctor: payload.doctor,
          detectedCapabilities: detected,
          lastHeartbeatAt: now,
          daemonIncompatibleSince: null,
          claudeCodeUnsupportedSince: claudeCodeUnsupported
            ? (machine.claudeCodeUnsupportedSince ?? now)
            : null,
          doctorErrorSince: doctorError ? (machine.doctorErrorSince ?? now) : null,
          updatedAt: now,
        })
        .where(and(eq(schema.machines.id, machine.id), isNull(schema.machines.revokedAt)))
        .returning({ id: schema.machines.id });
      // Revoked since it was read: nothing changes and the connection is refused below.
      if (updated.length === 0) return false;
      await recordEvent(tx, {
        actor: 'system',
        entityType: 'machine',
        entityId: machine.id,
        type: 'machine.online',
        payload: {
          name: machine.name,
          daemonVersion: payload.daemonVersion,
          claudeCodeVersion: payload.claudeCodeVersion,
          detected,
          unusable: [
            ...(claudeCodeUnsupported ? ['claude_code_unsupported'] : []),
            ...(doctorError ? ['doctor_error'] : []),
          ],
        },
      });
      return true;
    });
    if (!accepted) {
      this.refuseRevoked(connection, hello, log);
      return;
    }

    // A newer connection replaces an older one without the machine going offline in between.
    const older = this.connections.get(machine.id);
    if (older && older !== connection) {
      log.info('newer connection of the same machine: older one closed');
      this.end(older, DaemonCloseCode.replaced, 'replaced by a newer connection');
    }

    connection.welcomed = true;
    connection.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    // Closed while `hello` was handled: its close, queued after this, marks the machine offline.
    if (connection.closed) return;
    this.connections.set(machine.id, connection);
    await this.watchSilence(connection);
    this.send(connection, {
      type: 'welcome',
      id: hello.id,
      payload: { accepted: true, protocolVersion: PROTOCOL_VERSION, heartbeatIntervalSeconds },
    });
    log.info(
      {
        daemonVersion: payload.daemonVersion,
        claudeCodeVersion: payload.claudeCodeVersion,
        claudeCode: support,
        minimum: CLAUDE_CODE_MIN_VERSION,
        doctorError,
      },
      'daemon accepted',
    );
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The machine whose token authenticated a `/daemon` request. */
    machine?: { id: string; name: string };
  }
}
