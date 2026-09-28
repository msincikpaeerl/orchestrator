import { StreamMessage, type EventEntityType } from '@orchestrator/protocol';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Executor } from '../database.js';

// How saved changes reach the realtime stream (ADR 0029): the code writing a change sends a
// PostgreSQL notification in the same transaction, which PostgreSQL delivers only when that
// transaction commits, and never when it is rolled back. One connection listens and passes each
// notification to the open streams.

/** The PostgreSQL channel of the stream's messages. */
export const CHANGES_CHANNEL = 'orchestrator_changes';

/** "Something of this kind changed": sent with each event written (`recordEvent`). */
export async function notifyChange(
  db: Executor,
  change: { entity: EventEntityType; id: string | null; projectId: string | null },
): Promise<void> {
  await db.execute(sql`
    SELECT pg_notify(${CHANGES_CHANNEL}, json_build_object(
      'type', 'changed',
      'entity', ${change.entity}::text,
      'id', ${change.id}::text,
      'project', (SELECT "key" FROM "projects" WHERE "id" = ${change.projectId}::uuid)
    )::text)`);
}

/** The run has log entries up to `seq` (02, section 1). */
export async function notifyRunLog(db: Executor, runId: string, seq: number): Promise<void> {
  await db.execute(sql`
    SELECT pg_notify(${CHANGES_CHANNEL}, json_build_object(
      'type', 'run_log',
      'run', ${runId}::uuid,
      'project', (SELECT p."key" FROM "runs" r JOIN "projects" p ON p."id" = r."project_id"
                  WHERE r."id" = ${runId}::uuid),
      'seq', ${seq}::int
    )::text)`);
}

type Listener = (message: StreamMessage) => void;

/**
 * Listens to the changes channel on one connection of the pool and passes each message to its
 * listeners. A lost connection is replaced after `retryMs`; since notifications sent meanwhile
 * are lost, the listeners then get `resync`, and the screens read everything again.
 */
export class ChangeFeed {
  private readonly listeners = new Set<Listener>();
  private client: pg.PoolClient | null = null;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly options: { pool: pg.Pool; log: FastifyBaseLogger; retryMs: number },
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connects and listens; a failure is logged and retried, never thrown. */
  async start(): Promise<void> {
    await this.connect(false);
  }

  private async connect(reconnecting: boolean): Promise<void> {
    if (this.closed) return;
    let client: pg.PoolClient;
    try {
      client = await this.options.pool.connect();
    } catch (error) {
      this.options.log.error({ err: error }, 'realtime: database listener not connected');
      this.scheduleRetry();
      return;
    }
    // `close()` may have run while connecting.
    if (this.isClosed()) {
      client.release();
      return;
    }
    const lost = (error: unknown) => {
      if (this.client !== client) return;
      this.client = null;
      this.options.log.warn({ err: error }, 'realtime: database listener lost');
      client.release(error instanceof Error ? error : true);
      this.scheduleRetry();
    };
    client.on('error', lost);
    client.on('end', () => {
      lost(new Error('connection ended'));
    });
    client.on('notification', (notification) => {
      if (notification.channel !== CHANGES_CHANNEL || notification.payload === undefined) return;
      const parsed = StreamMessage.safeParse(parseJson(notification.payload));
      if (!parsed.success) {
        this.options.log.error({ payload: notification.payload }, 'realtime: unknown message');
        return;
      }
      this.emit(parsed.data);
    });
    try {
      await client.query(`LISTEN ${CHANGES_CHANNEL}`);
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      this.options.log.error({ err: error }, 'realtime: LISTEN failed');
      this.scheduleRetry();
      return;
    }
    this.client = client;
    if (reconnecting) {
      this.options.log.info('realtime: database listener reconnected');
      this.emit({ type: 'resync' });
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect(true);
    }, this.options.retryMs);
  }

  private emit(message: StreamMessage) {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const client = this.client;
    this.client = null;
    // Released to the pool with an error, so the connection holding the LISTEN is closed.
    client?.release(true);
    this.listeners.clear();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
