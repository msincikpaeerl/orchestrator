import pg from 'pg';

/** The clients of each pool made by `createPool` whose connection is not closed yet. */
const openClients = new WeakMap<pg.Pool, Set<pg.Client>>();

/**
 * Makes a pool that knows each of its connections from the moment the client is created until
 * its connection is closed, so that `endPool` can wait for all of them. The pool's own counts
 * forget a connection as soon as it starts closing (a connection released with an error, one idle
 * too long), which is still open for a moment. Every pool is made here, never with `new pg.Pool`.
 */
export function createPool(config: pg.PoolConfig): pg.Pool {
  const open = new Set<pg.Client>();
  class TrackedClient extends pg.Client {
    constructor(clientConfig?: string | pg.ClientConfig) {
      super(clientConfig);
      open.add(this);
      // `end` comes once the connection's socket is closed, whoever closed it.
      this.once('end', () => open.delete(this));
    }
  }
  const pool = new pg.Pool({ ...config, Client: TrackedClient });
  openClients.set(pool, open);
  return pool;
}

/**
 * Ends a pool made by `createPool` and resolves once every connection it ever had is closed,
 * including one that had already started closing. `pool.end()` alone resolves as soon as its
 * clients are taken out of the pool, while their connections may still be closing (pg-pool 3.14
 * starts `client.end()` without waiting for it): a database dropped just after, as test teardowns
 * do with `DROP DATABASE … WITH (FORCE)`, could still meet one and terminate it.
 */
export async function endPool(pool: pg.Pool): Promise<void> {
  const open = openClients.get(pool);
  if (!open) throw new Error('endPool needs a pool made by createPool');
  await pool.end();
  // A client leaves `open` on its `end`: each one still there has not ended yet.
  await Promise.all(
    [...open].map(
      (client) =>
        new Promise<void>((resolve) => {
          client.once('end', () => {
            resolve();
          });
        }),
    ),
  );
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
