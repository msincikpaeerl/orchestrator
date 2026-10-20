import type { NeedsYouItem } from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { ticketRef } from '../tickets/text';
import { machineFailureText } from './text';

// The two blocking items of lot 4 step D2b (02, section 4; 04, section 5.1; 07, section 4): CI
// cancelled because the branch changed on GitHub, and a ticket its machine kept from starting.

type CiCancelled = Extract<NeedsYouItem, { type: 'ci_cancelled' }>;
type MachineFailures = Extract<NeedsYouItem, { type: 'machine_failures' }>;

/** "CI cancelled for WEB-12", what happened and what Run now does. */
export function ciCancelledText(item: CiCancelled): { title: string; detail: string } {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  return {
    title: `CI cancelled for ${ref}: ${item.ticket.title}`,
    detail: `CI was cancelled on GitHub because the branch changed there, so the run on ${item.machine.name} ended. It does not count as a failed attempt. The scheduler does not start ${ref} by itself until you use Run now: the next run takes the branch as it is on GitHub.`,
  };
}

/** "<ticket> could not start on <machine>", each failure, and what to do (07, section 4). */
export function machineFailuresText(item: MachineFailures): {
  title: string;
  detail: string;
  failures: string[];
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  const machine = item.machine.name;
  const count = item.failures.length;
  const runs =
    count === 1 ? `Its run on ${machine}` : `Its last ${String(count)} runs on ${machine}`;
  return {
    title: `${ref} could not start on ${machine}`,
    detail: `${runs} failed because of the machine, not because of the ticket's work. Machine failures before asking you is ${String(item.limit)}, so the scheduler no longer starts ${ref} by itself. Check the machine on its page, then use Run now: it starts on any machine that can take the run.`,
    failures: item.failures.map(
      (failure) => `${formatDateTime(failure.at)}: ${machineFailureText[failure.cause]}`,
    ),
  };
}
