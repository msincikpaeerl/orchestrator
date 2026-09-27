import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { endPool, reportConnectionErrors } from '../src/pool.js';
import { createTestDatabase } from '../src/testing.js';

// `endPool` (CI of lot 2 step H: a test database dropped while a connection of the test's pool was
// still closing; `DROP DATABASE … WITH (FORCE)` terminated it and the pool emitted 57P01).

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

  it('leaves no connection for a database dropped right after', async () => {
    const errors: string[] = [];
    for (let round = 0; round < 5; round++) {
      const database = await createTestDatabase();
      const pool = new pg.Pool({ connectionString: database.url });
      pool.on('error', (error: Error & { code?: string }) => {
        errors.push(error.code ?? error.message);
      });
      // Several connections at once, then idle in the pool.
      await Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT 1')));
      expect(pool.totalCount).toBe(4);
      await endPool(pool);
      await database.drop();
      // A terminated connection reports its error on a later turn of the event loop.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(errors).toEqual([]);
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
      await terminate(database.url, await backendPid(held));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(reported).toEqual(['57P01']);
      held.release(true);
      released = true;

      // Idle in the pool.
      const idle = await pool.connect();
      const pid = await backendPid(idle);
      idle.release();
      await terminate(database.url, pid);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(reported).toEqual(['57P01', '57P01']);

      // New connections replace them.
      expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      if (!released) held.release(true);
      await endPool(pool);
      await database.drop();
    }
  });
});
