import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
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
 * Agent profiles (01, section 3.6). Default profiles are seeded from `agents/` when the server
 * starts (03, section 3); `role` is an `AgentRole`, `allowed_tools` a `string[]` of Claude Code
 * permission rules, `mcp_permissions` a `McpPermission[]` of `@orchestrator/protocol`.
 */
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    role: text('role').notNull(),
    /** Role instructions (layer 2 of 03, section 3); the common rules are added at each run. */
    instructions: text('instructions').notNull(),
    model: text('model').notNull(),
    allowedTools: jsonb('allowed_tools').notNull().default([]),
    mcpPermissions: jsonb('mcp_permissions').notNull().default([]),
    requiredCapabilities: jsonb('required_capabilities').notNull().default([]),
    isDefault: boolean('is_default').notNull(),
    version: integer('version').notNull().default(1),
    /**
     * For a default profile, the SHA-256 of the shipped files its version covers (its file and the
     * common rules): a different value at start raises the version.
     */
    shippedHash: text('shipped_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('agent_profiles_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_]*$'`),
    check(
      'agent_profiles_role',
      sql`${table.role} IN ('planner', 'builder', 'reviewer', 'writer')`,
    ),
    check('agent_profiles_version', sql`${table.version} >= 1`),
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
    /** `owner`, or `agent` with the profile and the run that created it (`ticket_create`). */
    createdBy: text('created_by').notNull(),
    createdByProfileId: uuid('created_by_profile_id').references(() => agentProfiles.id),
    /** The run whose agent created it; no foreign key, since runs reference tickets. */
    createdByRunId: uuid('created_by_run_id'),
    /** Latest Definition of Done report accepted by `ticket_submit` (`DodReport`, 04 section 3.1). */
    dodReport: jsonb('dod_report'),
    /**
     * The checks of that report (`DodCheckResult[]`) and the workflow flag (04, section 3.1; lot 3
     * step F); null for a report accepted before 0.4.0, or none.
     */
    dodChecks: jsonb('dod_checks'),
    workflowChanges: boolean('workflow_changes'),
    /** The agent profile expected to do the work (01, section 3.4); null when unassigned. */
    assigneeProfileId: uuid('assignee_profile_id').references(() => agentProfiles.id),
    /** `t/<number>-<slug>`, set at the first run (01, section 3.4; 04, section 4). */
    branchName: text('branch_name'),
    /** Failed runs, for the retry policy; uncounted ends never change it (04, section 5). */
    attemptCount: integer('attempt_count').notNull().default(0),
    /**
     * The last push of the ticket branch the daemon reported as done (submission or run end): the
     * head pushed, when, from which machine, and the commits ahead of the base that head held
     * (`string[]`). What was pushed, not what GitHub holds now (01, section 3.4; lot 3 step D3).
     */
    githubBranchHead: text('github_branch_head'),
    githubBranchPushedAt: timestamp('github_branch_pushed_at', { withTimezone: true }),
    githubBranchPushedBy: uuid('github_branch_pushed_by').references(() => machines.id),
    githubBranchCommits: jsonb('github_branch_commits'),
    /**
     * The latest failed push since the last one done (`BranchPushFailure`): when, the machine,
     * the reason and the message; null after a push is done.
     */
    branchPushFailure: jsonb('branch_push_failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tickets_assignee_profile_id').on(table.assigneeProfileId),
    unique('tickets_project_number').on(table.projectId, table.number),
    // Target of the dependencies' foreign keys, which keep both tickets in one project.
    unique('tickets_project_id').on(table.projectId, table.id),
    check('tickets_number', sql`${table.number} >= 1`),
    check('tickets_created_by', sql`${table.createdBy} IN ('owner', 'agent')`),
    index('tickets_created_by_run_id').on(table.createdByRunId),
    check('tickets_attempt_count', sql`${table.attemptCount} >= 0`),
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
 * `owner`, `system` or `agent`, with the agent's profile and run.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    author: text('author').notNull(),
    authorProfileId: uuid('author_profile_id').references(() => agentProfiles.id),
    /** The run of an agent's comment; no foreign key, since runs reference tickets. */
    runId: uuid('run_id'),
    kind: text('kind').notNull(),
    /** For an `answer`, the question it answers. */
    answersCommentId: uuid('answers_comment_id'),
    /** Markdown, rendered sanitized (01, section 3.5). */
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'comments_kind',
      sql`${table.kind} IN ('note', 'question', 'answer', 'review', 'status_change')`,
    ),
    check('comments_author', sql`${table.author} IN ('owner', 'system', 'agent')`),
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
    /** `limited_until` is now plus the fallback delay: no reset time was known (07, section 5.2). */
    limitedUntilEstimated: boolean('limited_until_estimated').notNull().default(false),
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
    /** Build identifier of the daemon package (05, section 2); null when none was reported. */
    daemonBuild: text('daemon_build'),
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
    /** Since when the daemon speaks the previous protocol (unusable), for "Needs you". */
    daemonOutdatedSince: timestamp('daemon_outdated_since', { withTimezone: true }),
    /** Since when its build differs from the package the server serves (a warning). */
    daemonBuildDiffersSince: timestamp('daemon_build_differs_since', { withTimezone: true }),
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

/**
 * Runs (01, section 3.7). Allowed values of the text columns are the enums of
 * `@orchestrator/protocol` (`RunStatus`, `PauseReason`, `FailureReason`, `RunEndReason`, ...).
 * `status` is written only by the server's run module, in the transaction of its event.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** Empty for planning runs (lot 5). */
    ticketId: uuid('ticket_id').references(() => tickets.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => agentProfiles.id),
    profileVersion: integer('profile_version').notNull(),
    purpose: text('purpose').notNull(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => claudeAccounts.id),
    status: text('status').notNull(),
    pauseReason: text('pause_reason'),
    failureReason: text('failure_reason'),
    /** The daemon's fact at the end (`RunEndReason`), when it reported one. */
    endReason: text('end_reason'),
    endDetail: text('end_detail'),
    /** The run's attempt at the ticket, stated in its first message (07, section 3). */
    attempt: integer('attempt').notNull(),
    /** SHA-256 of the run token (06, section 2); the token itself is never stored. */
    runTokenHash: text('run_token_hash').notNull().unique(),
    /** Set when the run ends or is stopped: calls with the token are refused. */
    runTokenRevokedAt: timestamp('run_token_revoked_at', { withTimezone: true }),
    /** Id of the last `run.start` or `run.resume`, matched by its `ack`. */
    dispatchMessageId: uuid('dispatch_message_id'),
    /** `start`, `resume` or `answer`: what a missing acknowledgement undoes. */
    dispatchKind: text('dispatch_kind'),
    /** Without an acknowledgement by then, the dispatch is undone (07, section 2). */
    ackDeadline: timestamp('ack_deadline', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    claudeSessionId: text('claude_session_id'),
    sessionAlive: boolean('session_alive').notNull().default(false),
    branchName: text('branch_name').notNull(),
    baseBranch: text('base_branch').notNull(),
    /** Reported at the end: the branch head and the commits ahead of the base (`CommitSummary[]`). */
    branchHead: text('branch_head'),
    commits: jsonb('commits'),
    /**
     * What of that report the machine said was not on GitHub (`NotOnGitHub`); null when it did not
     * say (protocol 1, runs of 0.3.0): every commit no push held then counts (lot 3 step D3).
     */
    notOnGitHub: jsonb('not_on_github'),
    estimatedUsageUsd: doublePrecision('estimated_usage_usd'),
    /** Summary written by the agent: its submission's summary, or why it gave up. */
    outcome: text('outcome'),
    /** "Max tickets an agent may create per run" when the run started (04, section 8). */
    maxAgentTickets: integer('max_agent_tickets'),
    /** An accepted `ticket_submit` or `ticket_give_up`: no other decision after it. */
    decision: text('decision'),
    /** The agent's latest progress line, and the one shown (06, section 4.2). */
    progress: text('progress'),
    progressAt: timestamp('progress_at', { withTimezone: true }),
    progressShown: text('progress_shown'),
    progressShownAt: timestamp('progress_shown_at', { withTimezone: true }),
    /** The `run.input` carrying the owner's answer, until the daemon acknowledges it. */
    answerInputId: uuid('answer_input_id'),
    /**
     * When the server last sent `run.stop` for the run: until its end is reported, and at most
     * MCP call timeout plus Longest push after this, the run is "ending" and may still get a push
     * credential for its end push (05, sections 4.9 and 7; lot 3 step D2).
     */
    stopSentAt: timestamp('stop_sent_at', { withTimezone: true }),
    /** When the daemon reported the run's end (`run.state` `ended`). */
    endReportedAt: timestamp('end_reported_at', { withTimezone: true }),
    /** The run's latest push of the ticket branch (`PushResult`) and when it was reported. */
    push: jsonb('push'),
    pushAt: timestamp('push_at', { withTimezone: true }),
    /**
     * The run's accepted submission and its latest refused one (`SubmissionRecord`: the report,
     * each check's result, the workflow flag; lot 3 step F, owner's addition). Each holds a DoD
     * report of at most 256 KiB (04, section 8), replaced at each refusal: a run keeps two at most.
     */
    submission: jsonb('submission'),
    refusedSubmission: jsonb('refused_submission'),
    /**
     * Milliseconds spent in `starting` and `running`, and in `waiting_human` and `paused_quota`,
     * up to `status_since` (01, section 3.7), added at each status change.
     */
    workingMs: bigint('working_ms', { mode: 'number' }).notNull().default(0),
    waitingMs: bigint('waiting_ms', { mode: 'number' }).notNull().default(0),
    /** When the current status began. */
    statusSince: timestamp('status_since', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'runs_status',
      sql`${table.status} IN ('queued', 'dispatched', 'starting', 'running', 'waiting_human', 'paused_quota', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'runs_purpose',
      sql`${table.purpose} IN ('implement', 'review', 'plan', 'document', 'fix_review')`,
    ),
    check(
      'runs_pause_reason',
      sql`${table.pauseReason} IN ('usage_limit', 'suspected_usage_limit')`,
    ),
    check(
      'runs_failure_reason',
      sql`${table.failureReason} IN ('timeout', 'crash', 'agent_gave_up', 'dod_failed', 'machine_offline', 'machine_revoked', 'claude_code_unsupported', 'machine_problem', 'cancelled', 'ci_failed', 'ci_timeout', 'review_branch_moved', 'push_failed')`,
    ),
    check('runs_attempt', sql`${table.attempt} >= 1`),
    check('runs_decision', sql`${table.decision} IN ('submitted', 'gave_up')`),
    // At most one active run per ticket (01, invariant 2).
    uniqueIndex('runs_one_active_per_ticket')
      .on(table.ticketId)
      .where(
        sql`${table.status} IN ('queued', 'dispatched', 'starting', 'running', 'waiting_human', 'paused_quota')`,
      ),
    index('runs_ticket_id').on(table.ticketId, table.createdAt),
    index('runs_machine_id').on(table.machineId, table.status),
    index('runs_account_id').on(table.accountId, table.status),
    // History pages ended runs newest first (02, section 7).
    index('runs_ended_at').on(table.endedAt, table.id),
  ],
);

/**
 * A run's live log (02, section 7): one entry per transcript event, stored once per position,
 * masked and cut to "Longest stored log entry". Kept as long as the run.
 */
export const runLogEntries = pgTable(
  'run_log_entries',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    tool: text('tool'),
    text: text('text').notNull(),
    cut: boolean('cut').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

/**
 * Reports and acknowledgements already handled, by message id (05, section 3.3): a duplicate is
 * acknowledged again and changes nothing. Written in the transaction of the report's effect.
 */
export const daemonMessages = pgTable('daemon_messages', {
  id: uuid('id').primaryKey(),
  machineId: uuid('machine_id')
    .notNull()
    .references(() => machines.id),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
