import type { CiCheck, CiCheckFailure, RunCiWait } from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

// The run page's CI card while a run waits for CI (02, section 7; owner's words, lot 3 step G1b).
// Every sentence is the owner's: no internal name (the wait's states, GitHub's field names).

/** The status line of a run waiting for CI, on the run page, in Activity and on the board. */
export const WAITING_FOR_CI = 'Waiting for CI';

/** A check's state, as the card and Help show it. */
export const ciCheckStateLabel: Record<CiCheck['state'], string> = {
  pending: 'Not finished',
  passed: 'Passed',
  failed: 'Failed',
};

/** What a check is: "<name> · workflow" or "<name> · status". */
export const ciCheckKindLabel: Record<CiCheck['kind'], string> = {
  workflow_run: 'workflow',
  status: 'status',
};

/** The default branch's name, or words for it when the project has none recorded. */
function baseName(ci: RunCiWait): string {
  return ci.base ?? 'the default branch';
}

const AFTER_DEADLINE = 'the run stops without counting as a failed attempt';

/**
 * The card's sentences, in order: what the run waits for and until when, then what is known of
 * CI's start: nothing appeared yet, a conflict being worked out, or a conflict.
 */
export function ciWaitText(ci: RunCiWait, now: Date): string[] {
  const deadline = formatDateTime(ci.deadline);
  if (ci.since === null) {
    return [
      `The work was accepted at ${formatDateTime(ci.submittedAt)}, but the pull request is not opened yet, so CI cannot start. The Orchestrator tries again at every check; see the ticket for why. If it is still not opened at ${deadline}, ${AFTER_DEADLINE}.`,
    ];
  }
  const pullRequest =
    ci.pullRequest === null ? '' : ` (pull request #${String(ci.pullRequest.number)})`;
  const lines = [
    `Waiting for CI on GitHub for commit ${ci.commit.slice(0, 7)}${pullRequest} since ${formatDateTime(ci.since)}. If CI has not finished by ${deadline}, ${AFTER_DEADLINE}.`,
    ci.checkedAt === null
      ? 'Not checked on GitHub yet.'
      : `Last checked at ${formatDateTime(ci.checkedAt)}.`,
  ];
  const result = ci.result;
  if (result?.state === 'conflict') {
    lines.push(
      `The pull request conflicts with ${baseName(ci)}, so GitHub started no CI and the work cannot be accepted: the agent is told to merge ${baseName(ci)} and resolve the conflict, then hand its work in again.`,
    );
  } else if (result === null || result.checks.length === 0) {
    const startDeadline = ci.startDeadline === null ? null : new Date(ci.startDeadline);
    lines.push(
      startDeadline === null || now < startDeadline
        ? `No CI run or status has appeared on GitHub yet. If none appears by ${formatDateTime(ci.startDeadline ?? ci.deadline)}, the work is accepted as “No CI found”, unless the pull request conflicts with ${baseName(ci)}.`
        : `Nothing appeared on GitHub. GitHub is still working out whether the pull request conflicts with ${baseName(ci)}; it is checked again shortly.`,
    );
  }
  return lines;
}

/** Why GitHub could not be checked, in the owner's words. */
export function ciProblemReason(failure: CiCheckFailure): string {
  switch (failure.reason) {
    case 'unreachable':
      return 'GitHub could not be reached, or answered with a server error';
    case 'rate_limited':
      return failure.retryAt === null
        ? "GitHub's request limit was reached; GitHub did not say when it allows requests again"
        : `GitHub's request limit was reached; it allows requests again at ${formatDateTime(failure.retryAt)}`;
    case 'unreadable':
      return failure.fields.length === 0
        ? "GitHub's answer could not be read"
        : `GitHub's answer could not be read (${failure.fields.join('; ')})`;
    case 'token':
      return failure.message.startsWith('No GitHub token')
        ? 'no GitHub token is saved'
        : 'the saved token cannot be used';
    case 'permission_missing':
      return `the token is missing a permission: ${failure.message}`;
    case 'refused':
      return `GitHub refused: ${failure.message}`;
  }
}

/** The line saying GitHub could not be checked at the latest check, since when and why. */
export function ciProblemText(failure: CiCheckFailure): string {
  return `GitHub could not be checked at ${formatDateTime(failure.at)} (since ${formatDateTime(failure.since)}): ${ciProblemReason(failure)}. The run keeps waiting and the Orchestrator asks again.`;
}
