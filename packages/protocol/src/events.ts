import { z } from 'zod';
import {
  BranchProtection,
  HarnessElement,
  ProjectKind,
  RepositoryOrigin,
  SetupStep,
} from './api/projects.js';
import { AccountPlan } from './api/machines.js';
import { SettingName } from './api/settings.js';
import {
  CommentKind,
  OwnerTicketAction,
  TicketPriority,
  TicketStatus,
  TicketType,
} from './api/tickets.js';

/** Who caused an event (01, section 3.10). `cli` is a command run in the server container. */
export const EventActor = z.enum(['owner', 'system', 'cli']);
export type EventActor = z.infer<typeof EventActor>;

export const EventEntityType = z.enum([
  'owner',
  'session',
  'github_connection',
  'project',
  'ticket',
  'setting',
  'claude_account',
  'machine',
  'agent_profile',
]);
export type EventEntityType = z.infer<typeof EventEntityType>;

/** Event types written so far; each lot adds its own. Payloads never contain secrets. */
export const EventType = z.enum([
  'owner.created',
  'owner.login_throttled',
  'owner.password_reset',
  'session.created',
  'session.revoked',
  'github.token_saved',
  'github.token_checked',
  'github.token_rejected',
  'github.token_unreadable',
  'github.permission_refused',
  'project.created',
  'project.updated',
  'project.setup_step',
  'project.setup_failed',
  'project.setup_retried',
  'project.ready',
  'project.harness_checked',
  'project.archived',
  'project.unarchived',
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.dependency_added',
  'ticket.dependency_removed',
  'ticket.commented',
  'setting.changed',
  'setting.reset',
  'account.created',
  'account.updated',
  'machine.created',
  'machine.enrollment_code_created',
  'machine.enrolled',
  'machine.enrollment_throttled',
  'machine.online',
  'machine.offline',
  'machine.daemon_incompatible',
  'machine.disabled',
  'machine.enabled',
  'machine.revoked',
  'machine.capabilities_changed',
  'agent_profile.created',
  'agent_profile.updated',
]);
export type EventType = z.infer<typeof EventType>;

const ProjectFacts = { key: z.string() };
/** `project` is the key, `ticket` the reference (`WEB-12`). */
const TicketFacts = { project: z.string(), ticket: z.string() };
/** The machine's name when the event happened. */
const MachineFacts = { name: z.string() };
const SettingFacts = {
  name: SettingName,
  scope: z.enum(['global', 'project']),
  projectId: z.uuid().optional(),
  projectKey: z.string().optional(),
};

/**
 * What each event type's payload holds. Unknown fields are dropped when parsing, so the event log
 * only ever shows the fields listed here (and never a secret a payload might hold by mistake).
 */
export const EventPayloads = {
  'owner.created': z.object({ username: z.string() }),
  'owner.login_throttled': z.object({
    scope: z.enum(['username', 'address']),
    address: z.string().optional(),
    failures: z.int(),
    delaySeconds: z.int(),
  }),
  'owner.password_reset': z.object({ revokedSessions: z.int() }),
  'session.created': z.object({ expiresAt: z.iso.datetime() }),
  'session.revoked': z.object({ reason: z.string() }),
  'github.token_saved': z.object({ account: z.string(), expiresOn: z.string().nullable() }),
  'github.token_checked': z.object({ permissions: z.record(z.string(), z.string()) }),
  'github.token_rejected': z.object({ request: z.string() }),
  'github.token_unreadable': z.object({}),
  'github.permission_refused': z.object({
    permissions: z.array(z.string()),
    request: z.string(),
  }),
  'project.created': z.object({
    ...ProjectFacts,
    name: z.string(),
    kind: ProjectKind,
    origin: RepositoryOrigin,
    repository: z.string(),
    private: z.boolean(),
  }),
  'project.updated': z.object({
    ...ProjectFacts,
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  'project.setup_step': z.object({
    ...ProjectFacts,
    step: SetupStep,
    repository: z.string().optional(),
    reused: z.boolean().optional(),
    alreadyApplied: z.boolean().optional(),
    branchProtection: BranchProtection.optional(),
    missing: z.array(HarnessElement).optional(),
  }),
  'project.setup_failed': z.object({ ...ProjectFacts, step: SetupStep, reason: z.string() }),
  'project.setup_retried': z.object({ ...ProjectFacts, step: SetupStep.nullable() }),
  'project.ready': z.object(ProjectFacts),
  'project.harness_checked': z.object({ ...ProjectFacts, missing: z.array(HarnessElement) }),
  'project.archived': z.object(ProjectFacts),
  'project.unarchived': z.object(ProjectFacts),
  'ticket.created': z.object({
    ...TicketFacts,
    type: TicketType,
    title: z.string(),
    priority: TicketPriority,
    status: TicketStatus,
    blockedBy: z.array(z.string()),
    /** The assignee's key and name; absent in events written before 0.3.0. */
    assignee: z.string().nullable().optional(),
    assigneeName: z.string().optional(),
  }),
  /** `fields` names the fields changed; type, title and priority are copied when changed. */
  'ticket.updated': z.object({
    ...TicketFacts,
    fields: z.array(z.string()),
    type: TicketType.optional(),
    title: z.string().optional(),
    priority: TicketPriority.optional(),
    /** The new assignee's key and name when it changed; the key is null when it was removed. */
    assignee: z.string().nullable().optional(),
    assigneeName: z.string().optional(),
  }),
  'ticket.status_changed': z.object({
    ...TicketFacts,
    from: TicketStatus,
    to: TicketStatus,
    action: OwnerTicketAction,
    /** The comment explaining a **Mark as done manually**. */
    commentId: z.uuid().nullable(),
  }),
  'ticket.dependency_added': z.object({ ...TicketFacts, blockedBy: z.string() }),
  'ticket.dependency_removed': z.object({ ...TicketFacts, blockedBy: z.string() }),
  'ticket.commented': z.object({ ...TicketFacts, commentId: z.uuid(), kind: CommentKind }),
  'setting.changed': z.object({
    ...SettingFacts,
    previous: z.int().nullable(),
    value: z.int(),
  }),
  'setting.reset': z.object({ ...SettingFacts, previous: z.int() }),
  'account.created': z.object({
    label: z.string(),
    plan: AccountPlan,
    maxConcurrentRuns: z.int(),
  }),
  /** `fields` names the fields changed; their new values are copied. */
  'account.updated': z.object({
    label: z.string(),
    fields: z.array(z.string()),
    previousLabel: z.string().optional(),
    plan: AccountPlan.optional(),
    maxConcurrentRuns: z.int().optional(),
  }),
  'machine.created': z.object({ ...MachineFacts, account: z.string() }),
  'machine.enrollment_code_created': z.object({ ...MachineFacts, expiresAt: z.iso.datetime() }),
  'machine.enrolled': z.object(MachineFacts),
  /** Failed enrollment codes from one address (05, section 3.1). */
  'machine.enrollment_throttled': z.object({
    address: z.string(),
    failures: z.int(),
    delaySeconds: z.int(),
  }),
  /** A connection accepted, with what the daemon reported and why the machine is unusable. */
  'machine.online': z.object({
    ...MachineFacts,
    daemonVersion: z.string(),
    claudeCodeVersion: z.string().nullable(),
    detected: z.array(z.string()),
    unusable: z.array(z.enum(['claude_code_unsupported', 'doctor_error'])),
  }),
  'machine.offline': z.object({
    ...MachineFacts,
    reason: z.enum(['connection_closed', 'silent', 'server_restarted', 'revoked']),
  }),
  'machine.daemon_incompatible': z.object({
    ...MachineFacts,
    daemonVersion: z.string(),
    protocolVersion: z.int(),
  }),
  'machine.disabled': z.object(MachineFacts),
  'machine.enabled': z.object(MachineFacts),
  'machine.revoked': z.object(MachineFacts),
  'machine.capabilities_changed': z.object({
    ...MachineFacts,
    capabilities: z.array(z.string()),
  }),
  /** A default profile seeded from `agents/` at the server's start (03, section 3). */
  'agent_profile.created': z.object({ key: z.string(), name: z.string(), version: z.int() }),
  /** A shipped file of the profile, or the common rules, changed: the version went up. */
  'agent_profile.updated': z.object({
    key: z.string(),
    name: z.string(),
    previousVersion: z.int(),
    version: z.int(),
  }),
} satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
