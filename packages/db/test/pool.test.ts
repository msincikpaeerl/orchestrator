import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPool, endPool, reportConnectionErrors } from '../src/pool.js';
import { createTestDatabase } from '../src/testing.js';

// `createPool` and `endPool` (CI of lot 2 steps H and L2: a test database dropped while a
// connection of the test's pool was still closing; `DROP DATABASE … WITH (FORCE)` terminated it
// and the pool emitted 57P01) and `reportConnectionErrors`.

/** Waits for an effect that comes asynchronously, failing after `ms` (docs/dev/testing.md). */
async function until(
  condition: () => boolean,
  ms: number,
  what: string,
  poll?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + ms;
  await poll?.();
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await poll?.();
  }
}

/** Whether a client's connection has closed (its `end` event), for `until`. */
function watchEnd(client: pg.ClientBase): () => boolean {
  let ended = false;
  client.once('end', () => {
    ended = true;
  });
  return () => ended;
}

describe('endPool', () => {
  it('resolves only after every connection of the pool has ended', async () => {
    const database = await createTestDatabase();
    try {
      const pool = createPool({ connectionString: database.url });
      // Each client's own `end` event: its connection is closed.
      let open = 0;
      pool.on('connect', (client) => {
        open += 1;
        client.once('end', () => {
          open -= 1;
        });
      });
      await Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT 1')));
      expect(open).toBe(4);
      await endPool(pool);
      expect(open).toBe(0);
    } finally {
      await database.drop();
    }
  });

  it('waits for a connection that had already started closing', async () => {
    // CI of lot 2 step L2: a connection closing on its own (released with an error, or idle too
    // long) had left the pool's counts, so the teardown did not wait for it.
    const database = await createTestDatabase();
    try {
      const pool = createPool({ connectionString: database.url });
      const client = await pool.connect();
      const ended = watchEnd(client);
      // Closing, and already out of the pool's counts, but its connection is still open.
      client.release(true);
      expect(pool.totalCount).toBe(0);
      expect(ended()).toBe(false);
      await endPool(pool);
      expect(ended()).toBe(true);
    } finally {
      await database.drop();
    }
  });

  it('refuses a pool not made by createPool, whose connections it cannot know', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none' });
    await expect(endPool(pool)).rejects.toThrow('createPool');
    await pool.end();
  });

  it('resolves at once for a pool that never connected', async () => {
    const database = await createTestDatabase();
    try {
      const pool = createPool({ connectionString: database.url });
      await endPool(pool);
      expect(pool.ended).toBe(true);
    } finally {
      await database.drop();
    }
  });
});

describe('reportConnectionErrors', () => {
  /** Terminates a backend, as a PostgreSQL restart or an administrator would. */
  async function terminate(url: string, pid: number): Promise<void> {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }
  }

  const backendPid = async (client: pg.ClientBase) =>
    (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;

  it('reports a connection lost while idle or checked out, once each, and the pool goes on', async () => {
    const database = await createTestDatabase();
    const pool = createPool({ connectionString: database.url });
    const reported: string[] = [];
    reportConnectionErrors(pool, (error: Error & { code?: string }) => {
      reported.push(error.code ?? error.message);
    });
    const held = await pool.connect();
    let released = false;
    try {
      // Checked out, as in a transaction waiting between two queries: an unhandled error before.
      const heldEnded = watchEnd(held);
      await terminate(database.url, await backendPid(held));
      // The loss arrives as PostgreSQL's error, then the connection's end with a second error:
      // wait for both, so that "once" is checked after the second one could have come.
      await until(() => reported.length >= 1 && heldEnded(), 5000, 'the held connection lost');
      expect(reported).toEqual(['57P01']);
      held.release(true);
      released = true;

      // Idle in the pool.
      const idle = await pool.connect();
      const pid = await backendPid(idle);
      const idleEnded = watchEnd(idle);
      idle.release();
      await terminate(database.url, pid);
      await until(() => reported.length >= 2 && idleEnded(), 5000, 'the idle connection lost');
      expect(reported).toEqual(['57P01', '57P01']);

      // New connections replace them: the lost ones have left the pool.
      await until(() => pool.totalCount === 0, 5000, 'the lost connections out of the pool');
      expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      if (!released) held.release(true);
      await endPool(pool);
      await database.drop();
    }
  }, 30_000);

  it('reports a connection lost while one of its queries runs, once', async () => {
    // CI of lot 3 step J2c (pull request #70): a query of the server's own work (the GitHub
    // check loop) running when the connection was lost. PostgreSQL's error went to the query
    // only, and the pool, released with that error, ended the client before its connection
    // closed: the loss was never reported.
    const database = await createTestDatabase();
    const pool = createPool({ connectionString: database.url });
    const reported: string[] = [];
    reportConnectionErrors(pool, (error: Error & { code?: string }) => {
      reported.push(error.code ?? error.message);
    });
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const running = pool.query('SELECT pg_sleep(30)').then(
        () => null,
        (error: unknown) => error as Error & { code?: string },
      );
      let pid: number | undefined;
      await until(
        () => pid !== undefined,
        5000,
        'the query running',
        async () => {
          const { rows } = await admin.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'active'
                AND query = 'SELECT pg_sleep(30)'`,
          );
          pid = rows[0]?.pid;
        },
      );
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      expect((await running)?.code).toBe('57P01');
      // The pool closes the client: wait for that, so that "once" is checked after it.
      await until(() => pool.totalCount === 0, 5000, 'the lost connection out of the pool');
      await until(() => reported.length >= 1, 5000, 'the loss reported');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reported).toEqual(['57P01']);
      expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      await admin.end();
      await endPool(pool);
      await database.drop();
    }
  }, 30_000);
});
