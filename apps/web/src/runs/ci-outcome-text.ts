import type {
  CheckCiAgainResponse,
  CiCheckView,
  FailureReason,
  NeedsYouItem,
  RunCiHistory,
  RunCiOutcome,
  RunStatus,
  TicketCi,
  WorkflowFlag,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { ticketRef } from '../tickets/text';
import { ciCheckKindLabel } from './ci-text';
import { failureText } from './text';

// What a run's CI came to, in the owner's words (owner's answers, lot 3 steps G2 and G2c): the
// ticket page's CI line, the ended run's CI card with one line per round, the "Needs you" items of
// a run ended at **CI wait at submission**, and what **Check CI again** found. A round is a result
// sent back to the agent: a result that was not is never numbered and never reads as counted.

const short = (commit: string) => commit.slice(0, 7);

/** The failed checks: "test · workflow, deploy · status". */
export function failedChecksText(checks: CiCheckView[]): string {
  return checks
    .filter((check) => check.state === 'failed')
    .map((check) => `${check.name} · ${ciCheckKindLabel[check.kind]}`)
    .join(', ');
}

const RUN_NOW_FAILURE = "Run now gives the failure to the next run's agent.";
const RERUN = 'If you re-ran the failed jobs on GitHub, Check CI again reads the result again.';
const runNowConflict = (base: string) =>
  `Run now lets the agent merge ${base} and resolve the conflict.`;

function waitWords(minutes: number | null): string {
  return minutes === null
    ? 'CI wait at submission'
    : `CI wait at submission (${String(minutes)} minutes)`;
}

/** "(failed: test · workflow)", or nothing when no check is named. */
function failedList(checks: CiCheckView[]): string {
  const names = failedChecksText(checks);
  return names === '' ? '' : ` (failed: ${names})`;
}

/** ": test · workflow", or nothing when no check is named. */
function failedColon(checks: CiCheckView[]): string {
  const names = failedChecksText(checks);
  return names === '' ? '' : `: ${names}`;
}

function acceptedLaterText(outcome: RunCiOutcome): string | null {
  const later = outcome.acceptedLater;
  if (later === null) return null;
  const found = later.state === 'passed' ? 'CI passed' : 'No CI found';
  return `${found} on GitHub for commit ${short(outcome.commit)} (checked again by you at ${formatDateTime(later.at)}): the work was accepted without a session${later.attemptTakenBack ? ', and the failed attempt of that run no longer counts' : ''}.`;
}

/**
 * The ticket page's CI line (02, section 6.4): what the ticket's latest run with CI came to, and
 * what to do (**Check CI again** is a button beside it when offered; **Run now** the ticket's).
 */
export function ticketCiText(
  ci: TicketCi,
  ticket: {
    workflowFlag: WorkflowFlag | null;
    /** The ticket's pull request now, as last seen. */
    pullRequest?: { opened: { number: number; state: string } | null };
  },
): string[] {
  const { outcome } = ci;
  const commit = short(outcome.commit);
  const base = ci.base ?? 'the default branch';
  const later = acceptedLaterText(outcome);
  if (later !== null) return [later];
  switch (outcome.kind) {
    case 'waiting':
      return [
        `CI: waiting on GitHub for commit ${commit}${ci.submittedAt === null ? '' : ` since ${formatDateTime(ci.submittedAt)}`}. See the run for each check.`,
      ];
    case 'passed':
      return [
        `CI passed on GitHub for commit ${commit}${outcome.at === null ? '' : ` (checked at ${formatDateTime(outcome.at)})`}.`,
      ];
    case 'no_ci':
      return [
        ticket.workflowFlag === null
          ? `No CI found: nothing ran on GitHub for commit ${commit}, so the work was accepted without CI.`
          : 'No CI found, and the work changed workflow files: the agent may have removed or weakened CI. Read the changes in .github/workflows/ before merging.',
      ];
    case 'too_many': {
      const counted = `The run ended after ${String(outcome.failures)} CI failures${outcome.anyConflict ? ' or conflicts' : ''} (Most CI failures per run: ${String(ci.maxCiFailures ?? outcome.failures - 1)}).`;
      return outcome.conflict
        ? [
            `The pull request conflicts with ${base}, so GitHub ran no CI for commit ${commit}. ${counted}`,
            runNowConflict(base),
          ]
        : [
            `CI failed on GitHub for commit ${commit}${failedColon(outcome.checks)}. ${counted}`,
            `${RUN_NOW_FAILURE} ${RERUN}`,
          ];
    }
    case 'not_finished':
      return outcome.pullRequestOpened
        ? [
            `CI had not finished on GitHub for commit ${commit} when ${waitWords(ci.waitMinutes)} was reached.`,
            'If CI has finished since, Check CI again accepts the work without starting a session.',
          ]
        : ticket.pullRequest?.opened?.state === 'open'
          ? [
              `The pull request could not be opened on GitHub before ${waitWords(ci.waitMinutes)} was reached, so CI never ran then for commit ${commit}.`,
              `Pull request #${String(ticket.pullRequest.opened.number)} is open now: once CI has finished on GitHub, Check CI again accepts the work without starting a session.`,
            ]
          : [
              `The pull request could not be opened on GitHub before ${waitWords(ci.waitMinutes)} was reached, so CI never ran for commit ${commit}.`,
              'Use Try again in "Pull request not opened" first, then Check CI again.',
            ];
    case 'not_received':
      return [
        `CI failed on GitHub for commit ${commit}${failedList(outcome.checks)}, and the run's wait ended before the agent received the result.`,
        `${RUN_NOW_FAILURE} ${RERUN}`,
      ];
    case 'conflict': {
      const refused =
        outcome.notSent?.why === 'refused' && outcome.notSent.message !== null
          ? ` (machine ${ci.machine.name}: ${outcome.notSent.message})`
          : '';
      return [
        `The pull request conflicts with ${base}, so GitHub ran no CI for commit ${commit}, and the run's wait ended before the agent merged it${refused}.`,
        runNowConflict(base),
      ];
    }
    case 'cancelled':
      return [
        `CI was cancelled on GitHub because the branch changed there${outcome.pullRequestHead === null ? '' : ` (the pull request's head is now ${short(outcome.pullRequestHead)})`}.`,
        "Run now continues from GitHub's branch.",
      ];
    case 'after_round': {
      const ended = ci.failureReason === null ? 'it ended' : failureText[ci.failureReason];
      const round = String(outcome.round ?? 1);
      return [
        outcome.conflict
          ? `The pull request conflicted with ${base} for commit ${commit}. This was sent back to the agent as CI round ${round}, and the run then ended: ${ended}.`
          : `CI failed on GitHub for commit ${commit}${failedColon(outcome.checks)}. The result was sent back to the agent as CI round ${round}, and the run then ended: ${ended}.`,
        'Run now starts the next run.',
      ];
    }
    case 'ended': {
      const ended = ci.failureReason === null ? 'it ended' : failureText[ci.failureReason];
      return [
        `The run ended while it waited for CI on GitHub for commit ${commit}: ${ended}.`,
        'Run now starts the next run.',
      ];
    }
  }
}

/** One line of the run page's CI card, with the checks it lists (folded but the latest). */
export interface CiHistoryLine {
  label: string;
  checks: CiCheckView[];
}

/**
 * The run page's CI card for a run that ended, or worked again after a round (02, section 7;
 * owner's answer 2, lot 3 step G2c): one line per round, then the result that ended the run when
 * it was not sent back, then the work accepted later.
 */
export function ciHistoryLines(
  history: RunCiHistory,
  run: { machine: { name: string }; status: RunStatus; failureReason: FailureReason | null },
): CiHistoryLine[] {
  const base = history.base ?? 'the default branch';
  const { outcome } = history;
  const found = (kind: 'failed' | 'conflict', at: string | null) =>
    `${kind === 'failed' ? 'Failed' : `Conflicts with ${base}`}${at === null ? '' : ` at ${formatDateTime(at)}`}`;
  const before =
    run.failureReason === 'ci_timeout'
      ? 'before CI wait at submission was reached'
      : run.status === 'running'
        ? null
        : 'before the run ended';
  const lines: CiHistoryLine[] = history.rounds.map((round) => {
    const head = `commit ${short(round.commit)} · ${found(round.kind, round.readAt)}`;
    if (round.confirmedAt !== null) {
      return {
        label: `Round ${String(round.round)} · ${head} · sent back to the agent`,
        checks: round.checks,
      };
    }
    const what = round.kind === 'failed' ? 'the result' : `the message to merge ${base}`;
    return {
      label:
        before === null
          ? `Not confirmed yet · ${head} · waiting for machine ${run.machine.name} to confirm it received ${what}`
          : `Not confirmed · ${head} · machine ${run.machine.name} did not confirm it received ${what} ${before}; not counted`,
      checks: round.checks,
    };
  });
  if (outcome === null) return lines;
  const commit = `commit ${short(outcome.commit)}`;
  const kind = outcome.conflict ? 'conflict' : 'failed';
  const end = (label: string) => {
    lines.push({ label, checks: outcome.checks });
  };
  switch (outcome.kind) {
    case 'too_many':
      end(
        `Not sent back · ${commit} · ${found(kind, outcome.at)} · the run ended: one ${kind === 'conflict' ? 'conflict' : 'failure'} more than Most CI failures per run (${String(history.maxCiFailures ?? outcome.failures - 1)})`,
      );
      break;
    case 'not_received':
    case 'conflict': {
      const why = outcome.notSent?.why;
      if (why === 'read_late' || why === undefined) {
        end(
          `Not sent back · ${commit} · ${found(outcome.kind === 'conflict' ? 'conflict' : 'failed', outcome.at)} · read on GitHub only after CI wait at submission was reached; not counted`,
        );
      } else if (why === 'refused') {
        end(
          `Not sent back · ${commit} · ${found(outcome.kind === 'conflict' ? 'conflict' : 'failed', outcome.at)} · ${outcome.notSent?.message ?? 'the machine could not take it'}; not counted`,
        );
      }
      break;
    }
    case 'not_finished':
      end(
        outcome.pullRequestOpened
          ? `Commit ${short(outcome.commit)} · Not finished when ${waitWords(history.waitMinutes)} was reached`
          : `Commit ${short(outcome.commit)} · The pull request was not opened before ${waitWords(history.waitMinutes)} was reached`,
      );
      break;
    case 'passed':
      end(
        `Commit ${short(outcome.commit)} · Passed${outcome.at === null ? '' : ` at ${formatDateTime(outcome.at)}`}`,
      );
      break;
    case 'no_ci':
      end(
        `Commit ${short(outcome.commit)} · No CI found${outcome.at === null ? '' : ` at ${formatDateTime(outcome.at)}`}`,
      );
      break;
    case 'cancelled':
      end(
        `Commit ${short(outcome.commit)} · Cancelled on GitHub${outcome.at === null ? '' : ` at ${formatDateTime(outcome.at)}`} because the branch changed there${outcome.pullRequestHead === null ? '' : ` (the pull request's head is now ${short(outcome.pullRequestHead)})`}`,
      );
      break;
    case 'ended':
      end(`Commit ${short(outcome.commit)} · Not finished when the run ended`);
      break;
    case 'waiting':
    case 'after_round':
      break;
  }
  const later = outcome.acceptedLater;
  if (later !== null) {
    lines.push({
      label: `Accepted later · Check CI again found ${later.state === 'passed' ? 'CI passed' : 'no CI on GitHub'} at ${formatDateTime(later.at)}${later.attemptTakenBack ? '; the failed attempt of this run no longer counts' : ''}`,
      checks: [],
    });
  }
  return lines;
}

/** The "Needs you" item of a run ended at **CI wait at submission** (owner's answer 1). */
export function ciTimeoutItemText(item: Extract<NeedsYouItem, { type: 'ci_timeout' }>): {
  title: string;
  detail: string;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  const { outcome } = item;
  const commit = short(outcome.commit);
  const base = item.base ?? 'the default branch';
  const minutes = item.waitMinutes === null ? '' : `, ${String(item.waitMinutes)} minutes`;
  const handedIn =
    item.submittedAt === null
      ? 'handed its work in'
      : `handed its work in at ${formatDateTime(item.submittedAt)}`;
  const notCounted = 'this did not count as a failed attempt.';
  switch (outcome.kind) {
    case 'not_received': {
      const why =
        outcome.notSent?.why === 'not_confirmed'
          ? `machine ${item.machine.name} did not confirm it received it`
          : outcome.notSent?.why === 'refused'
            ? `machine ${item.machine.name} could not take it (${outcome.notSent.message ?? ''})`
            : 'the result was read on GitHub only after the wait had ended';
      return {
        title: `CI failed for ${ref}, and the agent did not get the result: ${item.ticket.title}`,
        detail: `CI failed on GitHub for commit ${commit}${failedList(outcome.checks)}, but the run's wait (CI wait at submission${minutes}) ended before the agent received the result: ${why}. The ticket is back in To do; ${notCounted} Run now starts a run whose agent reads the failure first.`,
      };
    }
    case 'conflict': {
      const why =
        outcome.notSent?.why === 'not_confirmed'
          ? `machine ${item.machine.name} did not confirm it received the message`
          : outcome.notSent?.why === 'refused'
            ? `machine ${item.machine.name} could not take the message (${outcome.notSent.message ?? ''})`
            : 'the conflict was found only after the wait had ended';
      return {
        title: `${ref} conflicts with ${base}: ${item.ticket.title}`,
        detail: `The pull request conflicts with ${base}, so GitHub ran no CI, and the run's wait (CI wait at submission${minutes}) ended before the agent merged it: ${why}. The ticket is back in To do; ${notCounted} ${runNowConflict(base)}`,
      };
    }
    default: {
      const title = `CI did not finish for ${ref}: ${item.ticket.title}`;
      return outcome.pullRequestOpened && item.pullRequest !== null
        ? {
            title,
            detail: `The agent ${handedIn} (commit ${commit}, pull request #${String(item.pullRequest)}), but CI on GitHub had not finished when ${waitWords(item.waitMinutes)} was reached. The ticket is back in To do with its branch and pull request; ${notCounted} If CI has finished since, Check CI again accepts the work without starting a session.`,
          }
        : item.pullRequest === null
          ? {
              title,
              detail: `The agent ${handedIn} (commit ${commit}), but its pull request could not be opened on GitHub before ${waitWords(item.waitMinutes)} was reached, so CI never ran. The ticket is back in To do with its branch; ${notCounted} Use Try again in "Pull request not opened for ${ref}" first, then Check CI again.`,
            }
          : {
              title,
              detail: `The agent ${handedIn} (commit ${commit}), but its pull request could not be opened on GitHub before ${waitWords(item.waitMinutes)} was reached, so CI never ran then. The ticket is back in To do with its branch; ${notCounted} Pull request #${String(item.pullRequest)} is open now: once CI has finished on GitHub, Check CI again accepts the work without starting a session.`,
            };
    }
  }
}

/** What **Check CI again** found, in the words of the owner's table (lot 3 step G2). */
export function checkCiAgainText(answer: CheckCiAgainResponse, ref: string): string {
  switch (answer.outcome) {
    case 'accepted':
      return `${answer.state === 'passed' ? 'CI passed' : 'No CI found'}: ${ref} moved to In review.${answer.attemptTakenBack ? ' Its failed attempt no longer counts.' : ''}`;
    case 'not_finished':
      return answer.total === 0
        ? `Nothing has appeared on GitHub yet (checked at ${formatDateTime(answer.at)}). Try again later.`
        : `CI has still not finished on GitHub (${String(answer.finished)} of ${String(answer.total)} checks finished, checked at ${formatDateTime(answer.at)}). Try again later.`;
    case 'failed':
      return `CI failed on GitHub${failedColon(answer.checks)}. The work was not accepted: Run now gives the failure to the agent.`;
    case 'conflict':
      return `The pull request conflicts with ${answer.base}, so GitHub runs no CI. ${runNowConflict(answer.base)}`;
    case 'github_problem':
      return `GitHub could not be checked: ${answer.message.replace(/[.]$/, '')}. Try again later.`;
  }
}
