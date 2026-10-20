import { z } from 'zod';
import { DoctorCheck } from '../daemon/connection.js';
import { PushFailureReason } from '../daemon/git.js';
import { AgentLink } from './agents.js';
import { RunCiOutcome } from './ci.js';
import { ClaudeAccount } from './machines.js';
import { ProjectKey, SetupStep } from './projects.js';
import {
  PullRequestConflict,
  PullRequestFailure,
  PullRequestHeadMoved,
  PullRequestReopenFailure,
  PullRequestWatchFailure,
} from './pull-requests.js';
import { ReviewDecision, ReviewEnd, ReviewStart, StopCause } from './reviews.js';
import { Run } from './runs.js';
import { Comment, TicketStatus, WorkflowFlag } from './tickets.js';
import { GitHash } from '../daemon/git.js';
import { MachineFailure } from './holds.js';
import { QueueReason } from './queue.js';
import { RunDownloadFailure } from './download-failure.js';
import {
  GITHUB_TOKEN_LIST_URL,
  PUSH_PERMISSION_WORDS,
  PushPermission,
} from './token-permissions.js';

const MachineRef = z.object({ id: z.uuid(), name: z.string() });

export { GITHUB_TOKEN_LIST_URL, PUSH_PERMISSION_WORDS, PushPermission };

const TicketRef = z.object({ projectKey: ProjectKey, number: z.int(), title: z.string() });

/**
 * One item of "Needs you" (02, section 4), besides the GitHub connection problems of
 * `GET /api/github`. Each lot adds its own types.
 */
export const NeedsYouItem = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project_setup_failed'),
    project: z.object({ key: ProjectKey, name: z.string() }),
    step: SetupStep,
    reason: z.string(),
    since: z.iso.datetime(),
  }),
  /** Setup still to do (02, section 3): no Claude account exists. */
  z.object({ type: z.literal('no_claude_account') }),
  /** Setup still to do: no machine is enrolled and not revoked. */
  z.object({ type: z.literal('no_machine') }),
  /** The daemon's protocol version is refused: update the daemon (05, section 3.2). */
  z.object({
    type: z.literal('daemon_incompatible'),
    machine: MachineRef,
    daemonVersion: z.string().nullable(),
    protocolVersion: z.int().nullable(),
    /** Help > Machines > "Update the daemon", for this server (05, section 2). */
    updateCommands: z.array(z.string()),
    since: z.iso.datetime(),
  }),
  /**
   * The daemon speaks the previous protocol (a 0.3.0 daemon from lot 3 on): online but unusable
   * until updated, "Update the daemon on X" (05, section 3.3; 09, section 6).
   */
  z.object({
    type: z.literal('daemon_outdated'),
    machine: MachineRef,
    daemonVersion: z.string(),
    serverVersion: z.string(),
    updateCommands: z.array(z.string()),
    since: z.iso.datetime(),
  }),
  /**
   * The daemon speaks this server's protocol but is another build than the package this server
   * serves, older or newer: not blocking, "The daemon on X is not the one this Orchestrator
   * provides" (05, section 3.3).
   */
  z.object({
    type: z.literal('daemon_build_differs'),
    machine: MachineRef,
    daemonVersion: z.string(),
    /** Null for a daemon run from its sources. */
    daemonBuild: z.string().nullable(),
    serverVersion: z.string(),
    providedBuild: z.string(),
    updateCommands: z.array(z.string()),
    since: z.iso.datetime(),
  }),
  /** Claude Code missing or below the minimum: the machine is unusable. */
  z.object({
    type: z.literal('claude_code_unsupported'),
    machine: MachineRef,
    version: z.string().nullable(),
    minimum: z.string(),
    since: z.iso.datetime(),
  }),
  /** `doctor` reports an error: the machine is unusable. */
  z.object({
    type: z.literal('machine_problem'),
    machine: MachineRef,
    checks: z.array(DoctorCheck),
    since: z.iso.datetime(),
  }),
  /**
   * A machine offline while runs are active on it (02, section 4): they show "machine offline",
   * and **Stop run** fails them with `machine_offline` (05, section 6).
   */
  z.object({
    type: z.literal('machine_offline_with_runs'),
    machine: MachineRef,
    /** The tickets of its active runs (`WEB-12`). */
    tickets: z.array(z.string()),
    /** The last message received from it. */
    since: z.iso.datetime(),
  }),
  /** An agent's open question, answered with the same answer box as the ticket page (04, section 6). */
  z.object({
    type: z.literal('question'),
    ticket: TicketRef,
    question: Comment,
    /** When it was asked. */
    since: z.iso.datetime(),
  }),
  /** A ticket an agent created with `ticket_create`: **Accept** or **Reject** (04, section 2). */
  z.object({
    type: z.literal('ticket_proposed'),
    ticket: TicketRef,
    agent: AgentLink.nullable(),
    /** When it was created. */
    since: z.iso.datetime(),
  }),
  /**
   * Work finished by an agent and left in review by 0.3.0, without a pull request (04 section 1;
   * from lot 3 step H4 only those): **Mark as done manually** or **Request changes**, judged from
   * the run's summary.
   */
  z.object({
    type: z.literal('work_to_check'),
    ticket: TicketRef,
    /** The summary of the accepted submission; null if none was stored. */
    summary: z.string().nullable(),
    /** The run that submitted it. */
    runId: z.uuid().nullable(),
    /** When it was submitted. */
    since: z.iso.datetime(),
  }),
  /**
   * "Ready for review" (02, section 4; owner's answers 4 and 5, lot 3 step H): a ticket in review
   * with a pull request and no run active, **Start review** (one session) or **Skip review**.
   */
  z.object({
    type: z.literal('ready_for_review'),
    ticket: TicketRef,
    pullRequest: z.object({ number: z.int().positive(), url: z.url() }),
    /** The commit CI checked for the accepted submission: the one a review reviews. */
    commit: GitHash,
    /** CI passed in the run, passed when **Check CI again** read it, or "No CI found". */
    ci: z.enum(['passed', 'passed_later', 'no_ci']),
    /** When **Check CI again** accepted the work; null when the run's own CI did. */
    checkedAgainAt: z.iso.datetime().nullable(),
    workflowFlag: WorkflowFlag.nullable(),
    /** Whether the review starts by itself (lot 4 step D3); never `not_finished` here. */
    start: ReviewStart,
    /** When the work entered review: its acceptance. */
    since: z.iso.datetime(),
  }),
  /**
   * "Review did not finish" (02, section 4; owner's answers 2, 3 and 5, lot 3 steps H and H4): the
   * latest review run of the work in review ended without a decision, or its decision was thrown
   * away. **Start review** or **Skip review**.
   */
  z.object({
    type: z.literal('review_not_finished'),
    ticket: TicketRef,
    runId: z.uuid(),
    machine: MachineRef,
    /** The decision thrown away, agent text masked; null when none was made. */
    decision: ReviewDecision.nullable(),
    end: ReviewEnd,
    /** When the run ended. */
    since: z.iso.datetime(),
  }),
  /**
   * A ticket stopped by the retry policy (02, section 4; 04, section 5; owner's answer 2, lot 3
   * step I): **Try again**, **Cancel** or **Mark as done manually**. Shown until one of them, or
   * **Reopen**, clears the stop.
   */
  z.object({
    type: z.literal('ticket_stopped'),
    ticket: TicketRef,
    cause: StopCause,
    count: z.int().positive(),
    limit: z.int().positive(),
    since: z.iso.datetime(),
  }),
  /**
   * A run ended with `push_failed` (04, section 5; lot 3 step F): its work is committed on the
   * machine but GitHub refused the push or could not be reached. Shown until the next push done
   * (an end push included), or until the ticket is cancelled or done; **Run now** continues it on
   * that machine.
   */
  z.object({
    type: z.literal('push_failed'),
    ticket: TicketRef,
    /** The machine holding the commits. */
    machine: MachineRef,
    reason: PushFailureReason,
    /** The permission the token needs, when GitHub's words say which; else null. */
    permission: PushPermission.nullable(),
    /** GitHub's or Git's words, masked. */
    message: z.string(),
    /** When the run ended. */
    since: z.iso.datetime(),
  }),
  /**
   * An `implement` or `fix_review` run ended `download_failed` (04, section 5; owner's answer 2,
   * lot 3 step K2): the machine could not download the project from GitHub at the run's start.
   * Blocking, with **Run now**; shown until a new run of the ticket starts, the ticket is done or
   * cancelled, or the machine is revoked. A review run that fails so is "Review did not finish".
   */
  z.object({
    type: z.literal('download_failed'),
    ticket: TicketRef,
    runId: z.uuid(),
    machine: MachineRef,
    /** Why, with Git's, GitHub's or the Orchestrator's words, masked. */
    download: RunDownloadFailure,
    /** When the run ended. */
    since: z.iso.datetime(),
  }),
  /**
   * The ticket's latest run ended `ci_cancelled` (04, section 5.1; owner's answer 3, lot 4 step A):
   * CI was cancelled on GitHub because the branch changed there. Blocking, with **Run now**; shown
   * until a new run of the ticket starts, or the ticket is done or cancelled.
   */
  z.object({
    type: z.literal('ci_cancelled'),
    ticket: TicketRef,
    runId: z.uuid(),
    machine: MachineRef,
    /** When the run ended. */
    since: z.iso.datetime(),
  }),
  /**
   * "<ticket> could not start on <machine>" (07, section 4; owner's new answer 1, lot 4 step A):
   * as many failures in a row caused by the machine as **Machine failures before asking you**
   * (`limit`, its value at the failure that reached it). Blocking, with **Run now**; shown until a
   * new run of the ticket starts, or the ticket is done or cancelled.
   */
  z.object({
    type: z.literal('machine_failures'),
    ticket: TicketRef,
    machine: MachineRef,
    /** Oldest first. */
    failures: z.array(MachineFailure),
    limit: z.int().positive(),
    /** When the failures reached the setting. */
    since: z.iso.datetime(),
  }),
  /**
   * An accepted submission whose pull request the server could not open or update (04, section
   * 3.1; lot 3 step F3): **Try again**. Shown until an attempt succeeds, or the ticket is done or
   * cancelled.
   */
  z.object({
    type: z.literal('pull_request_not_opened'),
    ticket: TicketRef,
    failure: PullRequestFailure,
    /**
     * The ticket's pull request when it is open, as last seen: the attempt failed to update it
     * ("Pull request not updated"; lot 3 step F4); null when there is none, or it is closed or
     * merged ("not opened").
     */
    openPullRequest: z.int().positive().nullable(),
    /** When the latest attempt failed. */
    since: z.iso.datetime(),
  }),
  /**
   * A run ended `ci_timeout` (04, section 3.1; owner's answer 1, lot 3 step G2c), not counted: by
   * its outcome, "CI did not finish" with **Check CI again** (`not_finished`), "CI failed, and the
   * agent did not get the result" (`not_received`) or a conflict (`conflict`), both with **Run
   * now**. Shown until the work is accepted, a new run starts, or the ticket is done or cancelled.
   */
  z.object({
    type: z.literal('ci_timeout'),
    ticket: TicketRef,
    runId: z.uuid(),
    machine: MachineRef,
    /** When the agent handed its work in. */
    submittedAt: z.iso.datetime().nullable(),
    pullRequest: z.int().positive().nullable(),
    waitMinutes: z.int().positive().nullable(),
    base: z.string().nullable(),
    outcome: RunCiOutcome,
    /** When the run ended. */
    since: z.iso.datetime(),
  }),
  /**
   * The ticket's pull request closed on GitHub without merging, or merged into another base than
   * the project's default branch (04, section 2; lot 3 step J3a), while the ticket is neither done
   * nor cancelled: the ticket is unchanged. Closed: **Reopen pull request** or **Cancel ticket**;
   * merged elsewhere (`mergedInto`), which GitHub never reopens: **Cancel ticket** or **Mark as
   * done manually**, and the next accepted submission opens a new pull request into the default
   * branch. Not shown for a pull request the Orchestrator closed at **Cancel**. Goes when the pull
   * request is found open again, or the ticket is done or cancelled.
   */
  z.object({
    type: z.literal('pull_request_closed'),
    ticket: TicketRef,
    status: TicketStatus,
    pullRequest: z.object({ number: z.int().positive(), url: z.url() }),
    /** The base it was merged into; null when it was closed without merging. */
    mergedInto: z.string().nullable(),
    /** The latest failed **Reopen pull request**; null when none. */
    reopenFailure: PullRequestReopenFailure.nullable(),
    /** GitHub's time of the close or the merge; when the server found it if GitHub gave none. */
    since: z.iso.datetime(),
  }),
  /**
   * A pull request to merge (02, section 4; lot 3 step J4a): a ticket on **Awaiting merge** whose
   * pull request is open as last read. The owner merges it on GitHub; the ticket goes to `done`
   * when the merge is found (step J1), and the item with it. **Request changes** is the ticket
   * page's, filled in with `conflict.request` on a conflict.
   */
  z.object({
    type: z.literal('pull_request_to_merge'),
    ticket: TicketRef,
    pullRequest: z.object({ number: z.int().positive(), url: z.url() }),
    /**
     * Quality's approval (its summary, agent text masked) or the owner's **Skip review**, the
     * latest of the two; null when neither is recorded.
     */
    review: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('approved'),
          commit: GitHash,
          summary: z.string().nullable(),
          at: z.iso.datetime(),
        }),
        z.object({ kind: z.literal('skipped'), at: z.iso.datetime() }),
      ])
      .nullable(),
    /**
     * The CI result of the work: passed in the run, passed when **Check CI again** read it, or "No
     * CI found", for the commit CI checked; null when none is recorded.
     */
    ci: z
      .object({
        result: z.enum(['passed', 'passed_later', 'no_ci']),
        commit: GitHash,
        checkedAgainAt: z.iso.datetime().nullable(),
      })
      .nullable(),
    workflowFlag: WorkflowFlag.nullable(),
    /** GitHub's conflict fact for the current head, with **Request changes**' filled-in text. */
    conflict: PullRequestConflict.extend({ request: z.string() }).nullable(),
    /** The head moved after the approval or the skip (step J3b). */
    headMoved: PullRequestHeadMoved.nullable(),
    /** The watch could not read this pull request at its latest check (step J3a). */
    watchFailure: PullRequestWatchFailure.nullable(),
    /** When the ticket entered **Awaiting merge**. */
    since: z.iso.datetime(),
  }),
  /** A run paused on a usage limit, detected or suspected: **Resume** or **Stop run**. */
  z.object({
    type: z.literal('run_paused'),
    run: Run,
    ticket: TicketRef,
    /** When it paused. */
    since: z.iso.datetime(),
    /**
     * Why the scheduler does not resume it yet (07, section 5.2; lot 4 step E), in the queue's
     * reasons: its own wait after a suspected limit (`quota_wait`), its account's limit, pause,
     * window or budget, or its machine; null when the scheduler resumes it at its next check.
     */
    resume: QueueReason.nullable(),
  }),
  /**
   * A run paused on a usage limit that the scheduler resumed `resumes` times, **Most resumes per
   * run** (`limit`, its current value), and that still hits a limit (07, section 5.2; lot 4 step
   * G). Blocking: the scheduler no longer resumes it; **Resume** (which starts the count again) or
   * **Stop run**. Shown instead of `run_paused`, until the run is resumed or ends.
   */
  z.object({
    type: z.literal('run_resumes_used'),
    run: Run,
    ticket: TicketRef,
    /** When it paused the last time. */
    since: z.iso.datetime(),
    resumes: z.int().positive(),
    limit: z.int().positive(),
  }),
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/**
 * The compact status line of a Claude account (02, section 4): in lot 2 "Available" or "Limited
 * until <time>", a limit whose time has passed shown available; from lot 4 also "Paused", the
 * window and the daily budget used.
 */
export const AccountStatus = ClaudeAccount.pick({
  id: true,
  label: true,
  state: true,
  limitedUntil: true,
  limitedUntilEstimated: true,
  today: true,
});
export type AccountStatus = z.infer<typeof AccountStatus>;

/**
 * `GET /api/needs-you`: setup still to do first, then the other items oldest first (by when their
 * reason began), and the status line of each Claude account, by label.
 */
export const NeedsYouResponse = z.object({
  items: z.array(NeedsYouItem),
  accounts: z.array(AccountStatus),
});
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;
