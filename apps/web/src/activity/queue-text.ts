import type {
  MachineUnavailable,
  QueueAccount,
  QueueCandidate,
  QueueKind,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { compactDayText, todayText } from '../machines/schedule-text';
import { accountStatusText, PAUSED_TEXT, queueReasonText } from '../runs/text';
import { priorityLabel } from '../tickets/text';

// Activity > Queue in plain words (02, section 7; 07, section 7; lot 4 step H): each account's
// line, then each candidate with what it starts and why it is not running, in Run now's words.

/** What a candidate starts (07, section 3). */
export const queueKindLabel: Record<QueueKind, string> = {
  resume: 'Resume its paused run',
  review: 'Review by Quality',
  fix_review: 'Fix after review',
  plan: 'Plan',
  implement: 'Implement',
};

/**
 * "Implement · high priority · blocks 2 tickets · after a failed attempt": what the candidate
 * starts and what places it in the scheduler's order (07, sections 3 and 6).
 */
export function candidateFactsText(candidate: QueueCandidate): string {
  const parts: string[] = [queueKindLabel[candidate.kind]];
  if (candidate.ticket !== null && candidate.ticket.priority !== 'normal') {
    parts.push(`${priorityLabel[candidate.ticket.priority].toLowerCase()} priority`);
  }
  if (candidate.blocks > 0) {
    parts.push(
      `${String(candidate.blocks)} ticket${candidate.blocks === 1 ? '' : 's'} wait${candidate.blocks === 1 ? 's' : ''} for it`,
    );
  }
  if (candidate.afterFailure) parts.push('after a failed attempt: behind the others of its kind');
  return parts.join(' · ');
}

/**
 * Why the candidate is not running, in Run now's words, or when it starts: at the scheduler's
 * next check (07, section 2), on the machine chosen for it.
 */
export function candidateReasonText(candidate: QueueCandidate): string {
  if (candidate.reason !== null) return queueReasonText(candidate.reason);
  const on = candidate.machine === null ? '' : `, on machine ${candidate.machine.name}`;
  return candidate.kind === 'resume'
    ? `The scheduler resumes it at its next check${on}.`
    : `The scheduler starts it at its next check${on}.`;
}

/**
 * The machine reasons the owner's start overrides or releases (07, sections 3 to 5): **Run now**
 * ignores windows and the daily budget, and lets a machine left out for the ticket take it again.
 */
const OVERRIDDEN: readonly MachineUnavailable['why'][] = [
  'account_outside_window',
  'account_budget_used',
  'left_out',
];

/**
 * Whether the line offers its start (**Run now**, **Start review** or **Resume**; owner, review of
 * lot 4 step H): on a candidate that can start, and where the start overrides or releases what
 * stops it (a window, the daily budget, a hold, a machine left out, a suspected limit's wait,
 * reviews switched off). Not where only another action elsewhere lifts the refusal: a blocker, no
 * assignee, the project, GitHub, a stopped ticket, a blocking "Needs you" item with its own button,
 * the account's limit, pause or maximum, a machine that cannot take it.
 */
export function candidateStartOffered(candidate: QueueCandidate): boolean {
  // The scheduler alone starts a request's planning: no Run now for requests (lot 5 step E2b).
  if (candidate.kind === 'plan') return false;
  const { reason } = candidate;
  if (reason === null) return true;
  switch (reason.reason) {
    case 'held':
    case 'quota_wait':
    case 'reviews_off':
      return true;
    case 'machine_unavailable':
      return OVERRIDDEN.includes(reason.unavailable.why);
    case 'no_machine':
      return reason.machines.some(({ unavailable }) => OVERRIDDEN.includes(unavailable.why));
    default:
      return false;
  }
}

/**
 * Why an account starts no run now (07, sections 3 and 5): its limit, **Stop new runs**, its
 * maximum, its windows or its daily budget; null when it can start one.
 */
export function accountUnavailableText(unavailable: MachineUnavailable | null): string | null {
  if (unavailable === null) return null;
  switch (unavailable.why) {
    case 'account_limited':
      return 'Starts no run until its usage limit resets.';
    case 'account_paused':
      return `Starts no run: ${PAUSED_TEXT}. Resume it to let the scheduler start runs again.`;
    case 'account_busy':
      return `Starts no other run: it already runs its maximum of ${String(unavailable.maxConcurrentRuns)} run${unavailable.maxConcurrentRuns === 1 ? '' : 's'} at a time.`;
    case 'account_outside_window':
      return unavailable.next === null
        ? 'Starts no run by itself: outside its windows, and none opens within a week. Run now still starts one.'
        : `Starts no run by itself until its window opens at ${formatDateTime(unavailable.next)}. Run now still starts one.`;
    case 'account_budget_used':
      return `Starts no run by itself: its daily budget is used for today, until ${formatDateTime(unavailable.until)}. Run now still starts one.`;
    default:
      // A machine's reasons never apply to an account's line.
      return null;
  }
}

/**
 * The account's line (02, section 7): "Personal: Available · in its window until … · 1 of 2 runs
 * at a time", then its day against its budget, then why it starts no run, if so (its window, its
 * budget or its limit, said there rather than on the first line).
 */
export function accountLineText(line: QueueAccount): {
  title: string;
  today: string;
  unavailable: string | null;
} {
  const { status } = line;
  const unavailable = accountUnavailableText(line.unavailable);
  const runs = `${String(line.active)} of ${String(line.maxConcurrentRuns)} run${line.maxConcurrentRuns === 1 ? '' : 's'} at a time`;
  return {
    title: [
      `${line.account.label}: ${accountStatusText(status)}`,
      ...(unavailable === null ? compactDayText(status.today) : []),
      runs,
    ].join(' · '),
    today: `${todayText(status.today, status.dailyBudget)}.`,
    unavailable,
  };
}
