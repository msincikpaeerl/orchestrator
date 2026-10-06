import { z } from 'zod';
import { CommitSummary, GitHash, PushResult } from '../daemon/git.js';
import { RunEndReason, RunPurpose } from '../daemon/runs.js';
import { AgentKey } from './agents.js';
import { UnusableReason } from './machines.js';
import { PauseReason, RunStatus } from './run-status.js';
import { TicketStatus } from './tickets.js';

export {
  ACCOUNT_BUSY_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  PauseReason,
  RunStatus,
} from './run-status.js';

/** Why a run failed or was cancelled (01, section 3.7). */
export const FailureReason = z.enum([
  'timeout',
  'crash',
  'agent_gave_up',
  'dod_failed',
  'machine_offline',
  'machine_revoked',
  'claude_code_unsupported',
  'machine_problem',
  'cancelled',
  /** One CI failure more than **Most CI failures per run** (lot 3). */
  'ci_failed',
  /** **CI wait at submission** reached (lot 3). */
  'ci_timeout',
  /** The branch head moved during a review run (lot 3). */
  'review_branch_moved',
]);
export type FailureReason = z.infer<typeof FailureReason>;

/** Failure reasons never counted as a failed attempt (04, section 5). */
export const UNCOUNTED_FAILURES: readonly FailureReason[] = [
  'machine_offline',
  'machine_revoked',
  'claude_code_unsupported',
  'machine_problem',
  'cancelled',
  'ci_timeout',
  'review_branch_moved',
];

/** What made a run change status, for its events and the run page. */
export const RunChangeCause = z.enum([
  /** A report of the daemon (`run.state`, `run.quota_limited`) or its acknowledgement. */
  'daemon',
  'run_now',
  'resume',
  'owner_stopped',
  'ticket_cancelled',
  'ticket_done',
  /** The machine did not acknowledge `run.start` or `run.resume` in time (07, section 2). */
  'dispatch_timeout',
  /** The machine answered `run.start` or `run.resume` with a refusal. */
  'dispatch_refused',
  'machine_offline',
  'machine_revoked',
  /** The Claude Code version reported at the run's start is missing or too old (05, section 4.3). */
  'claude_code_unsupported',
  /** The owner answered the run's question: it resumes (04, section 6). */
  'answer',
]);
export type RunChangeCause = z.infer<typeof RunChangeCause>;

/** The ticket branch of a run, as the daemon reported it at the end (01, section 3.7). */
export const RunBranch = z.object({
  name: z.string(),
  head: GitHash.nullable(),
  /** Newest first; empty until reported. */
  commits: z.array(CommitSummary),
});
export type RunBranch = z.infer<typeof RunBranch>;

/** A run as the API shows it (02, sections 6.4 and 8). */
export const Run = z.object({
  id: z.uuid(),
  projectKey: z.string(),
  /** `WEB-12`. */
  ticket: z.string(),
  purpose: RunPurpose,
  profile: z.object({ key: AgentKey, name: z.string(), version: z.int().positive() }),
  machine: z.object({ id: z.uuid(), name: z.string(), online: z.boolean() }),
  account: z.object({ id: z.uuid(), label: z.string() }),
  status: RunStatus,
  pauseReason: PauseReason.nullable(),
  /**
   * A run paused on a detected limit: **Resume** is refused before `at`, its account's limit time,
   * `estimated` when it comes from the fallback delay (02, section 4). Null otherwise.
   */
  resumeAfter: z.object({ at: z.iso.datetime(), estimated: z.boolean() }).nullable(),
  failureReason: FailureReason.nullable(),
  /** The daemon's fact at the end, when it reported one. */
  endReason: RunEndReason.nullable(),
  /** Plain-words detail of the end, such as "workspace trust or startup dialog suspected". */
  endDetail: z.string().nullable(),
  /** The run's attempt at the ticket, from 1 (07, section 3). */
  attempt: z.int().positive(),
  /** Whether its Claude Code session is running on the machine. */
  sessionAlive: z.boolean(),
  branch: RunBranch,
  /**
   * The run's latest push of the ticket branch (at a submission or at its end) and when it was
   * reported; null when it pushed nothing (05, section 4.9; lot 3 step D3).
   */
  push: z.object({ result: PushResult, at: z.iso.datetime() }).nullable(),
  /** US dollars as Claude Code estimates them (05, section 4.5); null when unknown. */
  estimatedUsageUsd: z.number().nullable(),
  /**
   * The agent's progress line as shown: its latest `ticket_progress`, at most one new line per
   * "Progress update interval" (06, section 4.2); null before the first.
   */
  progress: z.object({ text: z.string(), at: z.iso.datetime() }).nullable(),
  /** The agent's summary at the end: its submission's summary, or why it gave up. */
  outcome: z.string().nullable(),
  /**
   * Time spent in `starting` and `running`, and in `waiting_human` and `paused_quota`, up to
   * `statusSince` (01, section 3.7): a screen adds the current period of an active run.
   */
  workingMs: z.int().min(0),
  waitingMs: z.int().min(0),
  /** When the current status began. */
  statusSince: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
});
export type Run = z.infer<typeof Run>;

/** Statuses whose time counts as working, and as waiting (01, section 3.7). */
export const WORKING_RUN_STATUSES: readonly RunStatus[] = ['starting', 'running'];
export const WAITING_RUN_STATUSES: readonly RunStatus[] = ['waiting_human', 'paused_quota'];

/** `GET /api/projects/:key/tickets/:number/runs`: newest first. */
export const RunListResponse = z.object({ runs: z.array(Run) });
export type RunListResponse = z.infer<typeof RunListResponse>;

/** Display constant: longest progress line shown on a board card; the ticket and run pages show it whole. */
export const PROGRESS_CARD_MAX_LENGTH = 120;

/** Display constant: log entries per page of a run's log (not a setting, 04 section 8). */
export const RUN_LOG_PAGE_SIZE = 200;

/** One stored entry of a run's log (02, section 7): masked, and cut to "Longest stored log entry". */
export const RunLogEntry = z.object({
  seq: z.int().min(0),
  at: z.iso.datetime(),
  kind: z.enum(['agent_text', 'tool_call', 'tool_result', 'input', 'warning']),
  tool: z.string().nullable(),
  text: z.string(),
  /** The entry was longer than "Longest stored log entry" and was cut. */
  cut: z.boolean(),
});
export type RunLogEntry = z.infer<typeof RunLogEntry>;

/** `GET /api/runs/:id/log?after=<seq>`: the entries after `after`, oldest first. */
export const RunLogQuery = z.object({ after: z.coerce.number().int().min(-1).default(-1) });
export const RunLogResponse = z.object({
  entries: z.array(RunLogEntry),
  /** More entries follow: ask again with the last `seq`. */
  more: z.boolean(),
});
export type RunLogResponse = z.infer<typeof RunLogResponse>;

const MachineRef = z.object({ id: z.uuid(), name: z.string() });
const AccountRef = z.object({ id: z.uuid(), label: z.string() });

/** Why one machine cannot take a run now (07, sections 3 and 4). */
export const MachineUnavailable = z.discriminatedUnion('why', [
  z.object({ why: z.literal('waiting_enrollment') }),
  z.object({ why: z.literal('offline') }),
  z.object({ why: z.literal('disabled') }),
  z.object({ why: z.literal('revoked') }),
  z.object({ why: z.literal('daemon_incompatible') }),
  z.object({ why: z.literal('unusable'), reasons: z.array(UnusableReason) }),
  z.object({ why: z.literal('missing_capabilities'), capabilities: z.array(z.string()) }),
  /** The account is `limited` until `until` (a usage limit detected, 07 section 5.2). */
  z.object({ why: z.literal('account_limited'), account: AccountRef, until: z.iso.datetime() }),
  /** The account already runs its maximum: `maxConcurrentRuns` is its current value. */
  z.object({
    why: z.literal('account_busy'),
    account: AccountRef,
    maxConcurrentRuns: z.int().positive(),
  }),
]);
export type MachineUnavailable = z.infer<typeof MachineUnavailable>;

/**
 * Why **Run now** or **Resume** cannot start (07, section 3): each refusal has a named reason, and
 * one tied to a setting or an account value states its current value.
 */
export const RunRefusal = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('ticket_not_todo'), status: TicketStatus }),
  z.object({ reason: z.literal('no_assignee') }),
  /** `tickets`: the tickets it waits for that are not done (`WEB-3`). */
  z.object({ reason: z.literal('blocked'), tickets: z.array(z.string()) }),
  z.object({ reason: z.literal('project_archived') }),
  z.object({ reason: z.literal('project_not_ready') }),
  z.object({ reason: z.literal('github_not_connected') }),
  z.object({ reason: z.literal('github_token_unreadable') }),
  z.object({ reason: z.literal('github_token_invalid') }),
  /** The GitHub account id, for the commit author, could not be read (04, section 4). */
  z.object({ reason: z.literal('github_account_unknown') }),
  /** Even with its description cut (03, section 3.2): shorten the ticket. */
  z.object({ reason: z.literal('first_message_too_large'), maxBytes: z.int().positive() }),
  /**
   * The one machine that can take it cannot now: the machine holding the ticket's commits
   * (`commits`), or a paused run's own machine (`commits` null).
   */
  z.object({
    reason: z.literal('machine_unavailable'),
    machine: MachineRef,
    commits: z.int().min(0).nullable(),
    unavailable: MachineUnavailable,
  }),
  /** No machine can take it: every machine not revoked, with why. */
  z.object({
    reason: z.literal('no_machine'),
    machines: z.array(z.object({ machine: MachineRef, unavailable: MachineUnavailable })),
  }),
  /** **Resume**: the run is not paused. */
  z.object({ reason: z.literal('run_not_paused'), status: RunStatus }),
  /** **Resume** of a detected limit before the reset time. */
  z.object({ reason: z.literal('account_limited'), account: AccountRef, until: z.iso.datetime() }),
  z.object({
    reason: z.literal('account_busy'),
    account: AccountRef,
    maxConcurrentRuns: z.int().positive(),
  }),
]);
export type RunRefusal = z.infer<typeof RunRefusal>;

/** Status changes of a ticket made by runs (04, section 2), besides the owner's actions. */
export const RunTicketAction = z.enum([
  /** `todo` → `in_progress`: **Run now**. */
  'run_now',
  /** → `todo`: the owner's **Stop run**. */
  'stop_run',
  /** `in_progress` → `in_review`: the agent's submission was accepted and its run ended. */
  'run_submitted',
  /** → `todo`: the run failed or was cancelled (`attemptCounted` says whether it counts). */
  'run_ended',
  /** `in_progress` → `waiting_human`: the agent asked a question with `ticket_ask`. */
  'question_asked',
  /** `waiting_human` → `in_progress`: the owner answered. */
  'answered',
]);
export type RunTicketAction = z.infer<typeof RunTicketAction>;
