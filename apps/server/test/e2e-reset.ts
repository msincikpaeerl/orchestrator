import type pg from 'pg';

/** Every table the end-to-end reset empties, by name: the default agent profiles stay. */
export async function resetTables(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    // The default agent profiles stay, as they are seeded before the first launch.
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_info', 'agent_profiles') ORDER BY tablename",
  );
  return rows.map((row) => row.tablename);
}

/**
 * Empties the tables between two end-to-end tests (`POST /reset` of `e2e-server.ts`). The
 * TRUNCATE takes each table's exclusive lock in turn, while a request of the previous test's page
 * may still be reading tables in another order (a join of `tickets` and `projects` for "Needs
 * you"): with both waiting, PostgreSQL ends one of them with "deadlock detected" (lot 3 step K1).
 * No order of the tables suits every query, so the reset gives way instead: it waits for a lock
 * at most `LOCK_TIMEOUT`, far below PostgreSQL's `deadlock_timeout` (1 second), so the request
 * goes on and the reset tries again.
 */
export async function emptyTables(pool: pg.Pool): Promise<void> {
  const tables = (await resetTables(pool)).map((name) => `"${name}"`).join(', ');
  const deadline = Date.now() + RESET_DEADLINE_MS;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || Date.now() > deadline) {
        throw error;
      }
    } finally {
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const LOCK_TIMEOUT = '100ms';
const RESET_DEADLINE_MS = 10_000;
/** PostgreSQL's error code when `lock_timeout` is reached. */
const LOCK_NOT_AVAILABLE = '55P03';
