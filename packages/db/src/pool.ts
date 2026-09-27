import type pg from 'pg';

/**
 * Ends a pool and resolves once every connection it had is closed. `pool.end()` alone resolves as
 * soon as its clients are taken out of the pool, while their connections may still be closing
 * (pg-pool 3.14 starts `client.end()` without waiting for it): a database dropped just after, as
 * test teardowns do with `DROP DATABASE … WITH (FORCE)`, could still meet one and terminate it.
 */
export async function endPool(pool: pg.Pool): Promise<void> {
  const open = pool.totalCount;
  let removed = 0;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    // `remove` comes after a client's connection has ended.
    pool.on('remove', () => {
      removed += 1;
      if (removed >= open) resolve();
    });
  });
  await pool.end();
  await closed;
}

/**
 * Makes a lost database connection (a PostgreSQL restart, an administrator's command) an error to
 * report instead of a crash. The pool's own `error` event covers idle connections only: a
 * connection checked out, as in a transaction waiting between two queries, reports on the client,
 * and an `error` event nobody listens to stops the process. So every connection gets a listener
 * when it is created, and each lost connection is reported once.
 */
export function reportConnectionErrors(pool: pg.Pool, report: (error: Error) => void): void {
  // Required by pg-pool for idle connections; the connection's listener below reports them.
  pool.on('error', () => undefined);
  pool.on('connect', (client) => {
    // A lost connection raises PostgreSQL's error, then "Connection terminated unexpectedly":
    // both are handled, the first is reported.
    let reported = false;
    client.on('error', (error) => {
      if (reported) return;
      reported = true;
      report(error);
    });
  });
}
