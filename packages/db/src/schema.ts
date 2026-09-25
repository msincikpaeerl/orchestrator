import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  primaryKey,
  timestamp,
  unique,
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
    /**
     * GitHub's numeric id of the account, for the address of agent commits (04, section 4). Null
     * for a token saved before 0.3.0 until its next check (02, section 3.2).
     */
    accountId: bigint('account_id', { mode: 'number' }),
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

/**
 * Append-only log of state changes (01, section 3.10). Payloads never contain secrets.
 * `project_id` is the project the event concerns, null for events about no project (owner,
 * sessions, GitHub connection, global settings). Declared after `projects`, which it references.
 */
export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (table) => [
    // The event log is read newest first by (time, id), whole or filtered: by project (and the
    // project list's last activity), by entity (a ticket, or a kind of entity).
    index('events_time').on(table.createdAt, table.id),
    index('events_project_time').on(table.projectId, table.createdAt, table.id),
    index('events_entity_time').on(table.entityType, table.entityId, table.createdAt, table.id),
  ],
);

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
    /**
     * Number of the project's last ticket. Incremented under the project's row lock when a ticket
     * is created, never decremented: numbers are never reused (01, section 3.4).
     */
    lastTicketNumber: integer('last_ticket_number').notNull().default(0),
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

/**
 * Tickets (01, section 3.4). Never deleted: cancelled. Allowed values of the text columns are the
 * enums of `@orchestrator/protocol` (`TicketType`, `TicketStatus`, ...). `status` is written only
 * by the server's transition module (04, section 2).
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** Shown with the project key: `WEB-12`. */
    number: integer('number').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** Ordered list of statements: `string[]`. */
    acceptanceCriteria: jsonb('acceptance_criteria').notNull().default([]),
    priority: text('priority').notNull(),
    status: text('status').notNull(),
    /** `owner`; agent profiles come with lot 2. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tickets_project_number').on(table.projectId, table.number),
    // Target of the dependencies' foreign keys, which keep both tickets in one project.
    unique('tickets_project_id').on(table.projectId, table.id),
    check('tickets_number', sql`${table.number} >= 1`),
    check('tickets_type', sql`${table.type} IN ('feature', 'bug', 'chore', 'docs', 'spike')`),
    check('tickets_priority', sql`${table.priority} IN ('low', 'normal', 'high')`),
    check(
      'tickets_status',
      sql`${table.status} IN ('proposed', 'todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge', 'done', 'cancelled')`,
    ),
  ],
);

/**
 * `ticket_id` is blocked by `blocked_by_id` (01, section 3.4): same project, never itself.
 * Cycles are refused by the server, which changes a project's dependencies under its row lock.
 */
export const ticketDependencies = pgTable(
  'ticket_dependencies',
  {
    projectId: uuid('project_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    blockedById: uuid('blocked_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ticketId, table.blockedById] }),
    foreignKey({
      name: 'ticket_dependencies_ticket',
      columns: [table.projectId, table.ticketId],
      foreignColumns: [tickets.projectId, tickets.id],
    }),
    foreignKey({
      name: 'ticket_dependencies_blocked_by',
      columns: [table.projectId, table.blockedById],
      foreignColumns: [tickets.projectId, tickets.id],
    }),
    check('ticket_dependencies_not_itself', sql`${table.ticketId} <> ${table.blockedById}`),
    index('ticket_dependencies_blocked_by_id').on(table.blockedById),
  ],
);

/**
 * Comments on tickets (01, section 3.5); comments on requests come with lot 5. `author` is
 * `owner` or `system`; agent profiles come with lot 2.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    author: text('author').notNull(),
    kind: text('kind').notNull(),
    /** Markdown, rendered sanitized (01, section 3.5). */
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'comments_kind',
      sql`${table.kind} IN ('note', 'question', 'answer', 'review', 'status_change')`,
    ),
    index('comments_ticket_id').on(table.ticketId, table.createdAt),
  ],
);

/**
 * Values of settings changed by the owner (04, section 8): a global value when `project_id` is
 * null, otherwise a project's override. A setting without a row uses its default, described with
 * its allowed range in `SETTINGS` of `@orchestrator/protocol`; **Reset to default** deletes the row.
 */
export const settingValues = pgTable(
  'setting_values',
  {
    name: text('name').notNull(),
    projectId: uuid('project_id').references(() => projects.id),
    value: integer('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One global value per setting: the null project counts as one value.
    unique('setting_values_name_project').on(table.name, table.projectId).nullsNotDistinct(),
  ],
);

/**
 * Claude accounts (01, section 3.9). Allowed values of the text columns are the enums of
 * `@orchestrator/protocol` (`AccountPlan`, `AccountState`).
 */
export const claudeAccounts = pgTable(
  'claude_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    plan: text('plan').notNull(),
    maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(1),
    state: text('state').notNull().default('available'),
    /** When `limited`: the expected reset time, when known. */
    limitedUntil: timestamp('limited_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claude_accounts_label').on(sql`lower(${table.label})`),
    check('claude_accounts_plan', sql`${table.plan} IN ('pro', 'max_5x', 'max_20x')`),
    check('claude_accounts_max_concurrent_runs', sql`${table.maxConcurrentRuns} BETWEEN 1 AND 10`),
    check(
      'claude_accounts_state',
      sql`${table.state} IN ('available', 'paused_manual', 'limited')`,
    ),
  ],
);

/**
 * Machines running a daemon (01, section 3.8). Never deleted. The token and the enrollment code
 * are kept as SHA-256 hashes only. `status` is the connection; enrolled, disabled and revoked are
 * the times those actions happened, null otherwise.
 */
export const machines = pgTable(
  'machines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => claudeAccounts.id),
    status: text('status').notNull().default('offline'),
    /** Reported by the daemon in `hello`; null before its first connection. */
    os: text('os'),
    daemonVersion: text('daemon_version'),
    protocolVersion: integer('protocol_version'),
    claudeCodeVersion: text('claude_code_version'),
    /** `DoctorCheck[]` of the last accepted connection. */
    doctor: jsonb('doctor').notNull().default([]),
    /** Capability tags (01, section 3.8): reported by the daemon, added and removed by the owner. */
    detectedCapabilities: jsonb('detected_capabilities').notNull().default([]),
    addedCapabilities: jsonb('added_capabilities').notNull().default([]),
    removedCapabilities: jsonb('removed_capabilities').notNull().default([]),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    /** Since when the last `hello` was refused for its protocol version; cleared by an accepted one. */
    daemonIncompatibleSince: timestamp('daemon_incompatible_since', { withTimezone: true }),
    /** Since when Claude Code is missing or below the minimum, for "Needs you". */
    claudeCodeUnsupportedSince: timestamp('claude_code_unsupported_since', { withTimezone: true }),
    /** Since when `doctor` reports an error, for "Needs you". */
    doctorErrorSince: timestamp('doctor_error_since', { withTimezone: true }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    tokenHash: text('token_hash').unique(),
    enrollmentCodeHash: text('enrollment_code_hash').unique(),
    enrollmentCodeExpiresAt: timestamp('enrollment_code_expires_at', { withTimezone: true }),
    /** Kept after use, so a reused code is told apart from an unknown one. */
    enrollmentCodeUsedAt: timestamp('enrollment_code_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('machines_name').on(sql`lower(${table.name})`),
    check('machines_status', sql`${table.status} IN ('online', 'offline')`),
    check('machines_os', sql`${table.os} IN ('linux', 'wsl')`),
    index('machines_account_id').on(table.accountId),
  ],
);
