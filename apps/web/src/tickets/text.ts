import {
  BLOCKABLE_STATUSES,
  PUSH_PERMISSION_WORDS,
  type AgentLink,
  type NeedsYouItem,
  type DodCheck,
  type TicketLink,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type TimelineEntry,
} from '@orchestrator/protocol';

export const statusLabel: Record<TicketStatus, string> = {
  proposed: 'Proposed',
  todo: 'To do',
  in_progress: 'In progress',
  waiting_human: 'Waiting for you',
  in_review: 'In review',
  awaiting_merge: 'Awaiting merge',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** A submission check in words (04, section 3.1). */
export const checkLabel: Record<DodCheck, string> = {
  criteria_met: 'acceptance criteria met',
  worktree_clean: 'all work committed',
  commits_ahead: 'commits on the branch',
  pushed: 'branch pushed to GitHub',
  type_rules: 'rules of the ticket type',
  paths_changed: 'listed files changed on the branch',
};

export const typeLabel: Record<TicketType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  chore: 'Chore',
  docs: 'Documentation',
  spike: 'Spike',
};

export const priorityLabel: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

/** The assignee as the screens show it: the profile's name. */
export function assigneeLabel(assignee: AgentLink | null): string {
  return assignee?.name ?? 'No assignee';
}

/** `WEB-12`: how every screen names a ticket. */
export function ticketRef(projectKey: string, number: number): string {
  return `${projectKey}-${String(number)}`;
}

export function ticketPath(projectKey: string, number: number): string {
  return `/projects/${encodeURIComponent(projectKey)}/tickets/${String(number)}`;
}

/**
 * Whether the owner is shown "Blocked": only before work starts, while dependencies can still
 * change (04, section 1; owner's decision, lot 1 step F).
 */
export function showsBlocked(ticket: { status: TicketStatus; blocked: boolean }): boolean {
  return ticket.blocked && BLOCKABLE_STATUSES.includes(ticket.status);
}

/** Why a ticket is blocked, and what the owner can do about a cancelled blocker (01, 3.4). */
export function blockedExplanation(
  projectKey: string,
  blockedBy: readonly TicketLink[],
): { waitingFor: string; cancelled: string | null } {
  const open = blockedBy.filter((link) => link.status !== 'done');
  const cancelled = open.filter((link) => link.status === 'cancelled');
  const name = (link: TicketLink) => ticketRef(projectKey, link.number);
  const list = (links: TicketLink[]) => links.map(name).join(', ');
  return {
    waitingFor: `It waits for ${list(open)}, which ${open.length === 1 ? 'is' : 'are'} not done yet. Work on it can start only once every ticket it waits for is done.`,
    cancelled:
      cancelled.length === 0
        ? null
        : `${list(cancelled)} ${cancelled.length === 1 ? 'is' : 'are'} cancelled, so this ticket stays blocked. Remove the dependency below if this ticket no longer needs ${cancelled.length === 1 ? 'it' : 'them'}, or reopen ${list(cancelled)}.`,
  };
}

/**
 * Warning of **Mark as done manually** when the ticket still waits for tickets that are not done
 * (02, section 6.4), naming each with its state; `null` when it waits for nothing.
 */
export function markDoneWarning(
  projectKey: string,
  number: number,
  blockedBy: readonly TicketLink[],
): string | null {
  const open = blockedBy.filter((link) => link.status !== 'done');
  if (open.length === 0) return null;
  const names = open.map(
    (link) => `${ticketRef(projectKey, link.number)} (${statusLabel[link.status]})`,
  );
  const last = names.pop() ?? '';
  const list = names.length === 0 ? last : `${names.join(', ')} and ${last}`;
  return `${ticketRef(projectKey, number)} still waits for ${list}, which ${open.length === 1 ? 'is' : 'are'} not done. Mark it as done anyway only if its work no longer needs ${open.length === 1 ? 'it' : 'them'}.`;
}

/** A status change of the timeline, in words. */
export function statusChangeText(entry: Extract<TimelineEntry, { type: 'status_change' }>): string {
  const who =
    entry.actor === 'owner' ? 'You' : entry.actor === 'agent' ? 'The agent' : 'The Orchestrator';
  if (entry.to === 'done' && entry.actor === 'owner') {
    return `${who} marked it as done manually (it was ${statusLabel[entry.from]}).`;
  }
  if (entry.to === 'cancelled') return `${who} cancelled it (it was ${statusLabel[entry.from]}).`;
  if (entry.from === 'cancelled' && entry.to === 'todo') return `${who} reopened it.`;
  if (entry.from === 'in_review' && entry.to === 'todo' && entry.actor === 'owner') {
    return `${who} requested changes: it went back to ${statusLabel.todo}.`;
  }
  return `${who} moved it from ${statusLabel[entry.from]} to ${statusLabel[entry.to]}.`;
}

/**
 * What a `push_failed` item of "Needs you" says (04, section 5; lot 3 step F): what happened and
 * what the owner does, a missing permission named as GitHub's token page names it.
 */
export function pushFailedText(item: Extract<NeedsYouItem, { type: 'push_failed' }>): {
  title: string;
  detail: string;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  const machine = item.machine.name;
  const committed = `The work is committed on machine ${machine} but is not on GitHub.`;
  const next = `press Run now on the ticket: the next run, on ${machine}, pushes the work.`;
  const runNow = `Then ${next}`;
  switch (item.reason) {
    case 'diverged':
      return {
        title: `The branch of ${ref} changed on GitHub`,
        detail: `GitHub's copy of the branch has commits machine ${machine} does not have (for example after "Update branch" on GitHub), so the work could not be pushed. Press Run now on the ticket: the next run, on ${machine}, brings GitHub's commits in with a merge, then pushes.`,
      };
    case 'unreachable':
      return {
        title: `GitHub could not be reached to push ${ref}`,
        detail: `${committed} Check that ${machine} is connected to the internet and that GitHub works. ${runNow}`,
      };
    case 'refused': {
      if (item.permission === null) {
        return {
          title: `GitHub refused the push of ${ref}`,
          detail: `${committed} GitHub's words are below. When their cause is fixed, ${next}`,
        };
      }
      const permission = PUSH_PERMISSION_WORDS[item.permission];
      const why =
        item.permission === 'workflows'
          ? ' The work changes a GitHub workflow (a file in .github/workflows/), which needs this permission.'
          : '';
      return {
        title: `GitHub refused the push of ${ref}: the token needs ${permission}`,
        detail: `${committed}${why} On GitHub's list of your tokens, open the Orchestrator's token, set ${permission}, and save it; do not regenerate it. ${runNow}`,
      };
    }
  }
}
