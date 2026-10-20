import { z } from 'zod';
import { CommitSummary, GitHash, PushResult } from '../daemon/git.js';
import { RunEndReason, RunPurpose } from '../daemon/runs.js';
import { CiCheckFailure, CiResult } from '../mcp/ci.js';
import { RunCiHistory } from './ci.js';
import { RunReview, StopCause } from './reviews.js';
import { SubmissionRecord } from '../mcp/dod-report.js';
import { AgentKey } from './agents.js';
import { MachineFailureCause } from './holds.js';
import { UnusableReason } from './machines.js';
import { FailureReason, PauseReason, RunStatus } from './run-status.js';
import { TicketStatus } from './tickets.js';
import { PullRequestState } from './pull-requests.js';
import { RunDownloadFailure } from './download-failure.js';

export {
  ACCOUNT_BUSY_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  FailureReason,
  PauseReason,
  RunStatus,
} from './run-status.js';

/** Failure reasons never counted as a failed attempt (04, section 5). */
export const UNCOUNTED_FAILURES: readonly FailureReason[] = [
  'machine_offline',
  'machine_revoked',
  'claude_code_unsupported',
  'machine_problem',
  'cancelled',
  'ci_timeout',
  'review_branch_moved',
  'push_failed',
  'ci_cancelled',
  'download_failed',
];

/** What made a run change status, for its events and the run page. */
export const RunChangeCause = z.enum([
  /** A report of the daemon (`run.state`, `run.quota_limited`) or its acknowledgement. */
  'daemon',
  'run_now',
  /** The scheduler's loop started the run (07, section 2; lot 4 step D2a). */
  'scheduler',
  'resume',
  /**
   * The scheduler resumed a run paused on a usage limit, once its wait was over (07, section 5.2;
   * lot 4 step E).
   */
  'scheduler_resume',
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
  /** The CI result of the run's submission: passed, "No CI found", or failed (lot 3 step G1a). */
  'ci_result',
  /** **CI wait at submission** reached without a CI result (04, section 3.1; lot 3 step G1a). */
  'ci_timeout',
  /**
   * A review decision's call found the pull request's head moved on GitHub: the review run is
   * stopped with `review_branch_moved` (06, section 4.5; lot 3 step H2).
   */
  'review_decision',
  /**
   * The ticket's pull request was found merged into the default branch: its active run is
   * stopped, `cancelled`, never counted (04, section 2; lot 3 step J1).
   */
  'pull_request_merged',
]);
export type RunChangeCause = z.infer<typeof RunChangeCause>;

/**
 * A run's wait for the CI result of its accepted submission (04, section 3.1; lot 3 step G1a).
 * The run stays `running`, shown "waiting for CI"; from `waitingSince` its time counts as waiting.
 */
export const RunCiWait = z.object({
  /** The commit pushed at the submission: its workflow runs and statuses are the result. */
  commit: GitHash,
  /** When the submission was accepted (lot 3 step G1b). */
  submittedAt: z.iso.datetime(),
  /** When the wait began: the pull request was open. Null while it is not opened yet. */
  since: z.iso.datetime().nullable(),
  /** When the agent's turn ended and the session went idle: waiting time from then. */
  waitingSince: z.iso.datetime().nullable(),
  /** **CI wait at submission** reached: from `since`, or from the submission while not opened. */
  deadline: z.iso.datetime(),
  /** **Wait for CI to start** reached; null while `since` is. */
  startDeadline: z.iso.datetime().nullable(),
  /** The latest result read, and when; null before the first check. */
  result: CiResult.nullable(),
  checkedAt: z.iso.datetime().nullable(),
  /** The latest check that failed, until one works again. */
  checkFailure: CiCheckFailure.nullable(),
  /**
   * The ticket's pull request, as last seen; null while it is not opened (lot 3 step G1b). Its
   * state (lot 3 step J3a): while it is `closed`, "No CI found" never accepts the work, so the
   * wait goes on until **CI wait at submission**.
   */
  pullRequest: z
    .object({ number: z.int().positive(), url: z.url(), state: PullRequestState })
    .nullable(),
  /** The project's default branch, the pull request's base: named by a conflict. */
  base: z.string().nullable(),
});
export type RunCiWait = z.infer<typeof RunCiWait>;

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
  /**
   * Why the project's download at the run's start failed, with the permission the token needs
   * when GitHub's words say which; null unless the run ended `download_failed` (lot 3 step K2).
   */
  download: RunDownloadFailure.nullable(),
  /** US dollars as Claude Code estimates them (05, section 4.5); null when unknown. */
  estimatedUsageUsd: z.number().nullable(),
  /**
   * The agent's progress line as shown: its latest `ticket_progress`, at most one new line per
   * "Progress update interval" (06, section 4.2); null before the first.
   */
  progress: z.object({ text: z.string(), at: z.iso.datetime() }).nullable(),
  /** The agent's summary at the end: its submission's summary, or why it gave up. */
  outcome: z.string().nullable(),
  /** The run's wait for CI after an accepted submission; null when it has none (lot 3 step G1a). */
  ci: RunCiWait.nullable(),
  /** Its CI rounds and what its CI came to; null when it never waited for CI (lot 3 step G2c). */
  ciHistory: RunCiHistory.nullable(),
  /** A review run's commit, decision and post; null for other runs (lot 3 step H4). */
  review: RunReview.nullable(),
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

/**
 * `GET /api/runs/:id` (02, section 7): the run with its latest refused submission, the report and
 * each check's result, credentials masked; null when none was refused (lot 3 step F4). Only the
 * run page reads it: a refused submission can weigh hundreds of KiB, too much for the lists.
 */
export const RunDetail = Run.extend({
  refusedSubmission: SubmissionRecord.nullable(),
  /**
   * When the run's accepted submission was handed in; null when none was. Later than the refused
   * one, the run page says the work was accepted after it (owner's correction, step F4).
   */
  acceptedSubmissionAt: z.iso.datetime().nullable(),
});
export type RunDetail = z.infer<typeof RunDetail>;

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

export const MachineRef = z.object({ id: z.uuid(), name: z.string() });
export const AccountRef = z.object({ id: z.uuid(), label: z.string() });

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
  /** The owner stopped new runs on the account (07, section 5.5; lot 4). */
  z.object({ why: z.literal('account_paused'), account: AccountRef }),
  /** The account already runs its maximum: `maxConcurrentRuns` is its current value. */
  z.object({
    why: z.literal('account_busy'),
    account: AccountRef,
    maxConcurrentRuns: z.int().positive(),
  }),
  /**
   * The scheduler only (07, section 5.3; lot 4): the account is outside its windows; `next` is
   * when the next one opens, null when none opens within a week. **Run now** ignores windows.
   */
  z.object({
    why: z.literal('account_outside_window'),
    account: AccountRef,
    next: z.iso.datetime().nullable(),
  }),
  /**
   * The scheduler only (07, section 5.4; lot 4): the account's daily budget is used for today,
   * until `until`, the day's end in the Orchestrator's time zone. **Run now** ignores the budget.
   */
  z.object({ why: z.literal('account_budget_used'), account: AccountRef, until: z.iso.datetime() }),
  /**
   * The scheduler only (07, section 4; lot 4): a run of this ticket on this machine ended at `at`
   * with a failure the machine caused (`cause`), so the machine is left out for the ticket until
   * it connects again or the owner's **Run now**.
   */
  z.object({ why: z.literal('left_out'), cause: MachineFailureCause, at: z.iso.datetime() }),
]);
export type MachineUnavailable = z.infer<typeof MachineUnavailable>;

/**
 * Why **Run now** or **Resume** cannot start (07, section 3): each refusal has a named reason, and
 * one tied to a setting or an account value states its current value.
 */
export const RunRefusal = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('ticket_not_todo'), status: TicketStatus }),
  z.object({ reason: z.literal('no_assignee') }),
  /**
   * Stopped by the retry policy (04, section 5; lot 3 step I): the cause, the count that passed
   * the setting and the setting's value then. **Try again** lets it continue.
   */
  z.object({
    reason: z.literal('ticket_stopped'),
    cause: StopCause,
    count: z.int().positive(),
    limit: z.int().positive(),
  }),
  /**
   * `tickets`: the tickets it waits for that are not done (`WEB-3`); `cancelled`, those of them
   * that are cancelled, which block until the dependency is removed (owner, review of lot 4 step
   * D1), absent when none is.
   */
  z.object({
    reason: z.literal('blocked'),
    tickets: z.array(z.string()),
    cancelled: z.array(z.string()).optional(),
  }),
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
  /** **Resume** on an account whose new runs the owner stopped (lot 4). */
  z.object({ reason: z.literal('account_paused'), account: AccountRef }),
  z.object({
    reason: z.literal('account_busy'),
    account: AccountRef,
    maxConcurrentRuns: z.int().positive(),
  }),
  /** **Start review** (lot 3 step H1): the ticket is not in review. */
  z.object({ reason: z.literal('ticket_not_in_review'), status: TicketStatus }),
  /** **Start review**: no pull request (a ticket left in review by 0.3.0). */
  z.object({ reason: z.literal('no_pull_request') }),
  /** **Start review**: a review run is already active. */
  z.object({ reason: z.literal('review_active') }),
  /**
   * **Start review**: the pull request's head on GitHub (`head`) is not the commit CI checked
   * (`commit`): someone changed the branch on GitHub (04, section 3.2; owner's answer 2a).
   */
  z.object({ reason: z.literal('review_head_moved'), commit: GitHash, head: GitHash }),
  /** **Start review**: the pull request is closed or merged on GitHub. */
  z.object({
    reason: z.literal('pull_request_not_open'),
    pullRequest: z.int().positive(),
    merged: z.boolean(),
  }),
  /**
   * **Start review**: GitHub could not be read (unreachable, a refusal in GitHub's masked words,
   * no token): try again.
   */
  z.object({ reason: z.literal('github_problem'), message: z.string() }),
]);
export type RunRefusal = z.infer<typeof RunRefusal>;

/** Status changes of a ticket made by runs (04, section 2), besides the owner's actions. */
export const RunTicketAction = z.enum([
  /** `todo` → `in_progress`: **Run now**. */
  'run_now',
  /** `todo` → `in_progress`: the scheduler's loop started a run (07, section 2; lot 4 D2a). */
  'scheduler_started',
  /** → `todo`: the owner's **Stop run**. */
  'stop_run',
  /** `in_progress` → `in_review`: the agent's submission was accepted and its run ended. */
  'run_submitted',
  /** → `todo`: the run failed or was cancelled (`attemptCounted` says whether it counts). */
  'run_ended',
  /**
   * `in_progress` (or `in_review`, in a review run) → `waiting_human`: the agent asked a question
   * with `ticket_ask`.
   */
  'question_asked',
  /** `waiting_human` → `in_progress`: the owner answered. */
  'answered',
  /** `todo` → `in_review`: the owner's **Check CI again** found CI passed (lot 3 step G2c). */
  'ci_checked_again',
  /** `waiting_human` → `in_review`: the owner answered Quality's question (lot 3 step H2). */
  'review_answered',
  /**
   * `waiting_human` → `in_review`: a review run with a question open was stopped, failed or
   * ended without its decision applied (04, section 2; owner's answer 6c, lot 3 step H2).
   */
  'review_ended',
  /** `in_review` → `awaiting_merge`: Quality's approval, applied at its run's end (lot 3 H2). */
  'review_approved',
  /** `in_review` → `todo`: Quality's request for changes, applied at its run's end (lot 3 H2). */
  'review_changes_requested',
  /**
   * → `done`: the ticket's pull request was found merged into the default branch, from every
   * state with an open pull request; an active run is stopped (04, section 2; lot 3 step J1).
   */
  'pull_request_merged',
]);
export type RunTicketAction = z.infer<typeof RunTicketAction>;
