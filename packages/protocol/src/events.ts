import { z } from 'zod';
import {
  BranchProtection,
  HarnessElement,
  ProjectKind,
  RepositoryOrigin,
  SetupStep,
} from './api/projects.js';
import { AccountPlan } from './api/machines.js';
import {
  FailureReason,
  PauseReason,
  RunChangeCause,
  RunStatus,
  RunTicketAction,
} from './api/runs.js';
import { PushFailureReason } from './daemon/git.js';
import { PullRequestFailureReason } from './api/pull-requests.js';
import { CheckCiAgainRefusal } from './api/ci.js';
import { CiCheckFailureReason, CiState } from './mcp/ci.js';
import { ReviewDecisionKind } from './api/reviews.js';
import { DodCheck } from './mcp/errors.js';
import { RunEndReason, RunPurpose } from './daemon/runs.js';
import { SettingName } from './api/settings.js';
import {
  CommentKind,
  OwnerTicketAction,
  TicketPriority,
  TicketStatus,
  TicketType,
} from './api/tickets.js';

/**
 * Who caused an event (01, section 3.10). `cli` is a command run in the server container; `agent`
 * an agent's MCP tool call, whose payload names the profile and the run.
 */
export const EventActor = z.enum(['owner', 'system', 'cli', 'agent']);
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
  'run',
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
  'ticket.submitted',
  'ticket.submission_refused',
  'ticket.pull_request_opened',
  'ticket.pull_request_reopened',
  'ticket.pull_request_updated',
  'ticket.pull_request_not_opened',
  'ticket.ci_checked_again',
  'setting.changed',
  'setting.reset',
  'account.created',
  'account.updated',
  'account.limited',
  'account.available',
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
  'machine.claude_code_unsupported',
  'machine.doctor_changed',
  'agent_profile.created',
  'agent_profile.updated',
  'run.created',
  'run.status_changed',
  'run.progress',
  'run.git_config_restored',
  'run.branch_pushed',
  'run.branch_push_failed',
  'run.ci_waiting',
  'run.ci_result',
  'run.ci_check_failed',
  'run.ci_check_recovered',
  'run.ci_round_sent',
  'run.ci_round_not_taken',
  'run.review_decided',
  'run.review_discarded',
]);
export type EventType = z.infer<typeof EventType>;

const ProjectFacts = { key: z.string() };
/** `project` is the key, `ticket` the reference (`WEB-12`). */
const TicketFacts = { project: z.string(), ticket: z.string() };
/** The machine's name when the event happened. */
const MachineFacts = { name: z.string() };
/** The agent behind an event with the `agent` actor: its profile's key and name, and its run. */
const AgentFacts = {
  agent: z.string().optional(),
  agentName: z.string().optional(),
  runId: z.uuid().optional(),
};
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
    /** For a ticket an agent created: its profile's key and name, and its run. */
    ...AgentFacts,
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
    action: z.union([OwnerTicketAction, RunTicketAction]),
    /** The comment explaining a **Mark as done manually**, or the `system` comment of a run. */
    commentId: z.uuid().nullable(),
    /** For the run actions: the run, and for `run_ended`, why and whether it counts. */
    runId: z.uuid().optional(),
    failureReason: FailureReason.optional(),
    attemptCounted: z.boolean().optional(),
    /** For a change an agent made (`question_asked`): its profile's key and name. */
    agent: z.string().optional(),
    agentName: z.string().optional(),
  }),
  'ticket.dependency_added': z.object({ ...TicketFacts, blockedBy: z.string() }),
  'ticket.dependency_removed': z.object({ ...TicketFacts, blockedBy: z.string() }),
  'ticket.commented': z.object({
    ...TicketFacts,
    commentId: z.uuid(),
    kind: CommentKind,
    ...AgentFacts,
  }),
  /** An agent's submission was accepted and its report stored (04, section 3.1). */
  'ticket.submitted': z.object({
    ...TicketFacts,
    ...AgentFacts,
    criteria: z.int(),
    /** The branch changes `.github/workflows/` (lot 3 step F); absent before 0.4.0. */
    workflowChanges: z.boolean().optional(),
  }),
  /**
   * An agent's submission was refused by the checks, which the run keeps with the report (04,
   * section 3.1; lot 3 step F).
   */
  'ticket.submission_refused': z.object({
    ...TicketFacts,
    ...AgentFacts,
    /** The failed checks, each once, in the order of 04 section 3.1. */
    failed: z.array(DodCheck),
  }),
  /**
   * The server opened the ticket's pull request after an accepted submission (04, section 3.1;
   * lot 3 step F3). `notReopened`: the number of a closed one GitHub refused to reopen.
   */
  'ticket.pull_request_opened': z.object({
    ...TicketFacts,
    number: z.int(),
    url: z.string(),
    notReopened: z.int().optional(),
  }),
  /** A pull request closed without merging, found by the ticket's branch, reopened and updated. */
  'ticket.pull_request_reopened': z.object({ ...TicketFacts, number: z.int(), url: z.string() }),
  /** The open pull request's title and description updated with the latest accepted report. */
  'ticket.pull_request_updated': z.object({ ...TicketFacts, number: z.int(), url: z.string() }),
  /** An attempt to open or update the pull request failed: "Needs you" offers **Try again**. */
  'ticket.pull_request_not_opened': z.object({
    ...TicketFacts,
    reason: PullRequestFailureReason,
    message: z.string(),
    /**
     * The ticket's pull request when it was open: the attempt failed to update it, not to open
     * one (lot 3 step F4); null otherwise, missing in events written before.
     */
    openPullRequest: z.int().positive().nullable().optional(),
  }),
  /**
   * The owner's **Check CI again** (04, section 3.1; lot 3 step G2c): what it found, or why it was
   * refused. `accepted` also writes the ticket's status change.
   */
  'ticket.ci_checked_again': z.object({
    ...TicketFacts,
    runId: z.uuid(),
    commit: z.string(),
    outcome: z.enum([
      'accepted',
      'not_finished',
      'failed',
      'conflict',
      'github_problem',
      'refused',
    ]),
    /** For `accepted`: passed or "No CI found", and whether a failed attempt was taken back. */
    state: z.enum(['passed', 'no_ci']).optional(),
    attemptTakenBack: z.boolean().optional(),
    refusal: CheckCiAgainRefusal.optional(),
    /** For `github_problem` and refusals: the words the owner saw. */
    message: z.string().optional(),
  }),
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
  /** A usage limit detected with certainty (05, section 4.10): no run starts before `until`. */
  'account.limited': z.object({
    label: z.string(),
    until: z.iso.datetime(),
    /** `reset_time`: reported by Claude Code; `fallback`: now plus the fallback delay. */
    source: z.enum(['reset_time', 'fallback']),
    fallbackMinutes: z.int().optional(),
  }),
  /** `limited_until` passed: written by the first action that reads the account after it. */
  'account.available': z.object({ label: z.string() }),
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
    /** From lot 3: the build reported (null without one) and whether it differs from the served one. */
    daemonBuild: z.string().nullable().optional(),
    buildDiffers: z.boolean().optional(),
    claudeCodeVersion: z.string().nullable(),
    detected: z.array(z.string()),
    unusable: z.array(z.enum(['claude_code_unsupported', 'doctor_error', 'daemon_outdated'])),
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
  /** The Claude Code version a run's start reported is missing or too old (05, section 4.3). */
  'machine.claude_code_unsupported': z.object({
    ...MachineFacts,
    version: z.string().nullable(),
    minimum: z.string(),
  }),
  /**
   * The daemon sent its checks again while connected (`machine.doctor`, 05 section 3.3): the
   * names of those reporting an error, which make the machine unusable.
   */
  'machine.doctor_changed': z.object({ ...MachineFacts, errors: z.array(z.string()) }),
  /** A default profile seeded from `agents/` at the server's start (03, section 3). */
  'agent_profile.created': z.object({ key: z.string(), name: z.string(), version: z.int() }),
  /** A shipped file of the profile, or the common rules, changed: the version went up. */
  'agent_profile.updated': z.object({
    key: z.string(),
    name: z.string(),
    previousVersion: z.int(),
    version: z.int(),
  }),
  'run.created': z.object({
    ...TicketFacts,
    purpose: RunPurpose,
    machine: z.string(),
    account: z.string(),
    /** The agent profile's key and name. */
    profile: z.string(),
    profileName: z.string(),
    profileVersion: z.int(),
    attempt: z.int(),
  }),
  'run.status_changed': z.object({
    ...TicketFacts,
    machine: z.string(),
    from: RunStatus,
    to: RunStatus,
    cause: RunChangeCause,
    pauseReason: PauseReason.optional(),
    failureReason: FailureReason.optional(),
    endReason: RunEndReason.optional(),
    /** Plain-words detail from the daemon or the server. */
    detail: z.string().optional(),
  }),
  /** A new progress line shown for the run (06, section 4.2). */
  'run.progress': z.object({ ...TicketFacts, ...AgentFacts, text: z.string() }),
  /**
   * The bare clone's Git configuration or hooks were changed during the run, and restored at its
   * end (05, section 7.1): the settings and hook files named, never their values.
   */
  'run.git_config_restored': z.object({
    ...TicketFacts,
    machine: z.string(),
    repository: z.string(),
    changes: z.string(),
  }),
  /** The daemon pushed the ticket branch to GitHub (05, section 4.9; lot 3 step D3). */
  'run.branch_pushed': z.object({
    ...TicketFacts,
    machine: z.string(),
    branch: z.string(),
    head: z.string(),
    /** At a submission, or at the run's end. */
    at: z.enum(['submission', 'end']),
  }),
  /** A push of the ticket branch failed: the commits stay on the machine. */
  'run.branch_push_failed': z.object({
    ...TicketFacts,
    machine: z.string(),
    branch: z.string(),
    at: z.enum(['submission', 'end']),
    reason: PushFailureReason,
    message: z.string(),
  }),
  /**
   * The run's submission waits for CI on GitHub from now: its pull request is open (04, section
   * 3.1; lot 3 step G1a). `commit` is the commit pushed at the submission, whose CI is read.
   */
  'run.ci_waiting': z.object({
    ...TicketFacts,
    commit: z.string(),
    pullRequest: z.int().positive().nullable(),
  }),
  /**
   * A CI result that decides, or a conflict that keeps the submission from passing (lot 3 step
   * G1a): the counts of the workflow runs and statuses, the names of those that failed, the
   * workflow flag of the submission, and the pull request's head when it is another commit.
   */
  'run.ci_result': z.object({
    ...TicketFacts,
    commit: z.string(),
    state: CiState.exclude(['pending']),
    checks: z.int().min(0),
    failed: z.array(z.string()),
    workflowChanges: z.enum(['changed', 'not_listed']).nullable(),
    baseBranch: z.string(),
    pullRequestHead: z.string().nullable(),
  }),
  /**
   * GitHub could not be checked for the run's CI (unreachable, the request limit, an answer that
   * cannot be read, the token): the run keeps waiting. Written when it starts, or its reason
   * changes (lot 3 step G1a).
   */
  'run.ci_check_failed': z.object({
    ...TicketFacts,
    reason: CiCheckFailureReason,
    message: z.string(),
  }),
  /** GitHub could be checked again for the run's CI after a failure. */
  'run.ci_check_recovered': z.object({ ...TicketFacts }),
  /**
   * A failed CI result or a conflict reached the agent: the machine confirmed the message, and the
   * round counts within **Most CI failures per run** (`of`; lot 3 step G2b).
   */
  'run.ci_round_sent': z.object({
    ...TicketFacts,
    commit: z.string(),
    kind: z.enum(['failed', 'conflict']),
    round: z.int().positive(),
    of: z.int().positive(),
  }),
  /**
   * The machine could not take a round yet (the base branch's download failed, say): not counted,
   * tried again at the next check. Written when it starts, or its words change (lot 3 step G2b).
   */
  'run.ci_round_not_taken': z.object({
    ...TicketFacts,
    commit: z.string(),
    kind: z.enum(['failed', 'conflict']),
    message: z.string(),
  }),
  /**
   * Quality's decision stored on its review run at the tool's call, applied at the run's end (06,
   * section 4.5; lot 3 step H2). `headChecked` false: GitHub could not be read at the call.
   */
  'run.review_decided': z.object({
    ...TicketFacts,
    ...AgentFacts,
    decision: ReviewDecisionKind,
    commit: z.string(),
    points: z.int().min(0),
    headChecked: z.boolean(),
  }),
  /**
   * A decision stored on a review run that ended without applying it (the head moved on the
   * machine, **Stop run**, the machine lost, ...): `failureReason` says why (lot 3 step H2).
   */
  'run.review_discarded': z.object({
    ...TicketFacts,
    machine: z.string(),
    decision: ReviewDecisionKind,
    commit: z.string(),
    failureReason: FailureReason.nullable(),
  }),
} satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
