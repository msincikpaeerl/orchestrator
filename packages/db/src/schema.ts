import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row, written by the first migration: when this database was initialised.
 * Proves that migrations run; the domain tables of 01 arrive with the lots that use them.
 */
export const schemaInfo = pgTable(
  'schema_info',
  {
    id: smallint('id').primaryKey().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('schema_info_single_row', sql`${table.id} = 1`)],
);
