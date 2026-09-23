import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
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

/**
 * Projects (01, section 3.1). Never deleted: archived. Allowed values of the text columns are the
 * enums of `@orchestrator/protocol` (`ProjectKind`, `SetupStatus`, `SetupStep`, ...).
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique among all projects, archived ones included, and immutable. */
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull(),
    kind: text('kind').notNull(),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    repoOrigin: text('repo_origin').notNull(),
    repoPrivate: boolean('repo_private').notNull(),
    /** Read from GitHub; null until the new repository is created. */
    defaultBranch: text('default_branch'),
    /**
     * When the creation of the new repository was first requested from GitHub. If the answer
     * was lost (restart), trying again uses the repository found under that name.
     */
    repoRequestedAt: timestamp('repo_requested_at', { withTimezone: true }),
    setupStatus: text('setup_status').notNull(),
    /** The step running or failed; null once ready. */
    setupStep: text('setup_step'),
    setupFailure: text('setup_failure'),
    setupFailedAt: timestamp('setup_failed_at', { withTimezone: true }),
    branchProtection: text('branch_protection'),
    /** Linked repositories: `HarnessElement[]` missing at the last check. */
    missingHarness: jsonb('missing_harness'),
    harnessCheckedAt: timestamp('harness_checked_at', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('projects_key_format', sql`${table.key} ~ '^[A-Z]{2,6}$'`),
    check('projects_kind', sql`${table.kind} IN ('web_app', 'website', 'android_app')`),
    check('projects_repo_origin', sql`${table.repoOrigin} IN ('created', 'linked')`),
    check('projects_setup_status', sql`${table.setupStatus} IN ('in_progress', 'ready', 'failed')`),
    check('projects_status', sql`${table.status} IN ('active', 'archived')`),
    // GitHub names are case-insensitive: one project per repository.
    uniqueIndex('projects_repository').on(
      sql`lower(${table.repoOwner})`,
      sql`lower(${table.repoName})`,
    ),
  ],
);
