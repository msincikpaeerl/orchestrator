import { schema } from '@orchestrator/db';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction: functions writing events accept both. */
export type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
