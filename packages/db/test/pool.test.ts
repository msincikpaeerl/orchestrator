import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { endPool, reportConnectionErrors } from '../src/pool.js';
import { createTestDatabase } from '../src/testing.js';

// `endPool` (CI of lot 2 step H: a test database dropped while a connection of the test's pool was
// still closing; `DROP DATABASE … WITH (FORCE)` terminated it and the pool emitted 57P01) and
// `reportConnectionErrors`.

/** Waits for an effect that comes asynchronously, failing after `ms` (docs/dev/testing.md). */
async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
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
      const pool = new pg.Pool({ connectionString: database.url });
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

  it('resolves at once for a pool that never connected', async () => {
    const database = await createTestDatabase();
    try {
      const pool = new pg.Pool({ connectionString: database.url });
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
    const pool = new pg.Pool({ connectionString: database.url });
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
});
