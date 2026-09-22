import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** The single human user (01, section 3.11). The check on `id` makes a second owner impossible. */
export const owner = pgTable(
  'owner',
  {
    id: smallint('id').primaryKey().default(1),
    username: text('username').notNull(),
    /** Argon2id hash in PHC format (ADR 0015). */
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('owner_single_row', sql`${table.id} = 1`)],
);

/** Login sessions of the owner (01, section 3.11; ADR 0015). Only a hash of the cookie is kept. */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * Recent failed logins per username and per client address (ADR 0015). Keys are
 * `username:<name>` and `address:<ip>`. A row is deleted by a successful login, and ignored once
 * its last failure is older than the loginFailureMemoryMinutes setting.
 */
export const loginFailures = pgTable('login_failures', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }).notNull(),
  /** No login is tried for this key before this time. */
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
});

/** Secrets encrypted with ORCHESTRATOR_SECRET_KEY (ADR 0016), for example the GitHub token. */
export const secrets = pgTable('secrets', {
  name: text('name').primaryKey(),
  /** Encryption scheme version, so a later scheme can re-encrypt old rows. */
  scheme: smallint('scheme').notNull(),
  nonce: bytea('nonce').notNull(),
  /** AES-256-GCM ciphertext followed by its 16-byte authentication tag. */
  ciphertext: bytea('ciphertext').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** What the Orchestrator knows about the saved GitHub token (02, sections 3.1 and 3.2). One row. */
export const githubConnection = pgTable(
  'github_connection',
  {
    id: smallint('id').primaryKey().default(1),
    account: text('account').notNull(),
    /** Entered by the owner; null for "No expiry date". */
    expiresOn: date('expires_on', { mode: 'string' }),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    /** Result of the last token check: `PermissionCheck[]` of the protocol package. */
    permissions: jsonb('permissions').notNull(),
    /** Set when the saved token cannot be decrypted (key changed, ADR 0016); cleared by a new token. */
    unreadableSince: timestamp('unreadable_since', { withTimezone: true }),
    /** Set when GitHub rejects the token as invalid; cleared by a successful check or a new token. */
    invalidSince: timestamp('invalid_since', { withTimezone: true }),
    /** Permission refusals seen during use: `{ permissions, request, at }[]`. */
    refusals: jsonb('refusals').notNull().default([]),
  },
  (table) => [check('github_connection_single_row', sql`${table.id} = 1`)],
);

/** Append-only log of state changes (01, section 3.10). Payloads never contain secrets. */
export const events = pgTable('events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
});
