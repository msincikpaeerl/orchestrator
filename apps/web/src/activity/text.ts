import {
  EventPayloads,
  SETTINGS,
  shorten,
  type CiCheckFailureReason,
  type EventActor,
  type EventEntityType,
  type EventLogEntry,
  type EventPayload,
  type EventType,
  type ReleaseAction,
} from '@orchestrator/protocol';
import { formatDate, formatDateTime, permissionLabel } from '../github/text';
import { budgetText, scheduleText } from '../machines/schedule-text';
import { concurrentRuns, planLabel } from '../machines/text';
import { amount } from '../settings/text';
import { branchProtectionLabel, harnessElement, kindLabel, stepLabel } from '../projects/text';
import {
  causeText,
  failureText,
  machineFailureText,
  pauseText,
  runStatusLabel,
} from '../runs/text';
import { requestPath, requestStatusLabel } from '../requests/text';
import { keptReasonText } from '../tickets/branch-clean-up-text';
import { checkLabel, priorityLabel, statusLabel, ticketPath, typeLabel } from '../tickets/text';

/**
 * A piece of an event's text: plain text, or a link to the project or ticket page. Owner or agent
 * content (titles, names, comments) is always a shortened quote linking to the page with the full
 * text; it is shown as plain text, never as Markdown or HTML.
 */
export type Piece = string | { text: string; to: string };

/** The event types in plain words, for the filter and for events whose payload is unreadable. */
export const eventTypeLabel: Record<EventType, string> = {
  'owner.created': 'Owner account created',
  'owner.login_throttled': 'Logins delayed after failures',
  'owner.password_reset': 'Password reset with the server command',
  'session.created': 'Logged in',
  'session.revoked': 'Logged out',
  'github.token_saved': 'GitHub token saved',
  'github.token_checked': 'GitHub token checked',
  'github.token_rejected': 'GitHub token refused by GitHub',
  'github.token_unreadable': 'GitHub token can no longer be read',
  'github.permission_refused': 'GitHub request refused for a missing permission',
  'project.created': 'Project created',
  'project.updated': 'Project renamed or described',
  'project.reviews_automatic_changed': 'Start reviews by themselves changed',
  'project.required_capabilities_changed': 'Required capabilities changed',
  'project.merges_automatic_changed': 'Merge automatically changed',
  'project.setup_step': 'Repository setup step done',
  'project.setup_failed': 'Repository setup failed',
  'project.setup_retried': 'Repository setup tried again',
  'project.ready': 'Project ready',
  'project.harness_checked': 'Harness elements checked',
  'project.archived': 'Project archived',
  'project.unarchived': 'Project unarchived',
  'project.pull_request_watch_failed': 'Pull requests not checked on GitHub',
  'project.pull_request_watch_recovered': 'Pull requests checked on GitHub again',
  'tickets.imported': 'Tickets imported',
  'ticket.created': 'Ticket created',
  'ticket.updated': 'Ticket edited',
  'ticket.status_changed': 'Ticket status changed',
  'ticket.dependency_added': 'Dependency added',
  'ticket.dependency_removed': 'Dependency removed',
  'ticket.commented': 'Comment added',
  'ticket.submitted': 'Work submitted by an agent',
  'ticket.submission_refused': 'Submission refused by the checks',
  'ticket.pull_request_opened': 'Pull request opened',
  'ticket.pull_request_reopened': 'Pull request reopened',
  'ticket.pull_request_updated': 'Pull request updated',
  'ticket.pull_request_not_opened': 'Pull request not opened or updated',
  'ticket.pull_request_merged': 'Pull request merged',
  'ticket.pull_request_closed': 'Pull request closed without merging',
  'ticket.pull_request_not_closed': 'Pull request not closed',
  'ticket.pull_request_not_reopened': 'Pull request not reopened',
  'ticket.pull_request_conflict': 'Pull request in conflict',
  'ticket.pull_request_conflict_gone': 'Pull request no longer in conflict',
  'ticket.merged_automatically': 'Pull request merged automatically',
  'ticket.automatic_merge_failed': 'Pull request not merged automatically',
  'ticket.review_posted': "Quality's review posted on GitHub",
  'ticket.review_not_posted': "Quality's review not known on GitHub",
  'ticket.ci_checked_again': 'CI checked again',
  'ticket.stopped': 'Ticket stopped',
  'ticket.tried_again': 'Ticket tried again',
  'ticket.held': 'Ticket held from the scheduler',
  'ticket.released': 'Ticket released',
  'ticket.could_not_start': 'Ticket could not start on a machine',
  'ticket.branch_deleted': 'Ticket branch deleted on GitHub',
  'ticket.branch_kept': 'Ticket branch kept on GitHub',
  'ticket.branch_pushed_again': 'Ticket branch on GitHub again',
  'ticket.machine_branch_deleted': 'Ticket branch deleted on a machine',
  'request.created': 'Request submitted',
  'request.commented': 'Comment added to a request',
  'request.status_changed': 'Request status changed',
  'ticket.machine_branch_kept': 'Ticket branch kept on a machine',
  'setting.changed': 'Setting changed',
  'setting.reset': 'Setting reset to default',
  'account.created': 'Claude account added',
  'account.updated': 'Claude account edited',
  'account.limited': 'Claude usage limit reached',
  'account.available': 'Claude account available again',
  'account.quota_wait_restarted': 'Quota wait back to its first length',
  'account.paused': 'New runs stopped on a Claude account',
  'account.resumed': 'Claude account resumed',
  'setting.time_zone_saved': 'Time zone saved',
  'machine.created': 'Machine added',
  'machine.enrollment_code_created': 'Enrollment code created',
  'machine.enrolled': 'Machine enrolled',
  'machine.enrollment_throttled': 'Enrollments delayed after wrong codes',
  'machine.online': 'Machine connected',
  'machine.offline': 'Machine offline',
  'machine.daemon_incompatible': 'Daemon too old or too new',
  'machine.disabled': 'Machine disabled',
  'machine.enabled': 'Machine enabled',
  'machine.revoked': 'Machine revoked',
  'machine.capabilities_changed': 'Machine capabilities edited',
  'machine.claude_code_unsupported': 'Claude Code too old at a run start',
  'machine.doctor_changed': 'Machine checks changed',
  'agent_profile.created': 'Agent profile added',
  'agent_profile.updated': 'Agent profile updated',
  'run.created': 'Run started',
  'run.status_changed': 'Run status changed',
  'run.progress': 'Run progress',
  'run.git_config_restored': 'Git configuration restored',
  'run.branch_pushed': 'Branch pushed to GitHub',
  'run.branch_push_failed': 'Branch push failed',
  'run.ci_waiting': 'Waiting for CI',
  'run.ci_result': 'CI result',
  'run.ci_check_failed': 'CI could not be checked on GitHub',
  'run.ci_check_recovered': 'CI checked on GitHub again',
  'run.ci_round_sent': 'CI result sent to the agent',
  'run.ci_round_not_taken': 'CI result not taken by the machine',
  'run.review_decided': "Quality's decision recorded",
  'run.review_discarded': "Quality's decision not applied",
};

/** Kinds of entity, for the filter. */
export const entityLabel: Record<EventEntityType, string> = {
  owner: 'Owner account',
  session: 'Login sessions',
  github_connection: 'GitHub connection',
  project: 'Projects',
  ticket: 'Tickets',
  request: 'Requests',
  setting: 'Settings',
  claude_account: 'Claude accounts',
  machine: 'Machines',
  agent_profile: 'Agent profiles',
  run: 'Runs',
};

/** Who caused the event. */
export const actorLabel: Record<EventActor, string> = {
  owner: 'You',
  system: 'Orchestrator',
  cli: 'Server command',
  agent: 'Agent',
};

/** What released a hold (lot 4 step D2b). */
const releaseText: Record<ReleaseAction, string> = {
  run_now: 'by your Run now',
  start_review: 'by your Start review',
  request_changes: 'by your Request changes',
  skip_review: 'by your Skip review',
  cancel: 'as you cancelled it',
  mark_done: 'as you marked it as done',
};

const ticketFieldLabel: Record<string, string> = {
  type: 'type',
  title: 'title',
  description: 'description',
  acceptanceCriteria: 'acceptance criteria',
  priority: 'priority',
  assignee: 'assignee',
};

function projectPath(key: string): string {
  return `/projects/${encodeURIComponent(key)}`;
}

/** Owner or agent content: on one line, shortened, in quotes, linking to its full text. */
function quote(text: string, to: string | null): Piece {
  const quoted = `“${shorten(text)}”`;
  return to === null ? quoted : { text: quoted, to };
}

/** "Request 7" as a link to the request. */
function requestLink(number: number): Piece {
  return { text: `Request ${String(number)}`, to: requestPath(number) };
}

/** `WEB-12` as a link to the ticket. */
function ticketRefLink(reference: string): Piece {
  const match = /^([A-Z]{2,6})-(\d+)$/.exec(reference);
  return match?.[1] && match[2]
    ? { text: reference, to: ticketPath(match[1], Number(match[2])) }
    : reference;
}

function list(items: string[]): string {
  return items.join(', ');
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${String(seconds / 60)} minute${seconds === 60 ? '' : 's'}`;
  return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}

interface Context {
  /** The project's key, linked to its page; the key from the payload when the link is unknown. */
  project: Piece;
  projectTo: string | null;
  /** The ticket's reference, linked to its page. */
  ticket: Piece;
  ticketTo: string | null;
  comment: string | null;
}

type Describe<T extends EventType> = (payload: EventPayload<T>, context: Context) => Piece[];

const describe: { [T in EventType]: Describe<T> } = {
  'owner.created': (p) => ['Owner account created with the username ', quote(p.username, null)],
  'owner.login_throttled': (p) => [
    `After ${String(p.failures)} failed logins ${
      p.scope === 'address' ? `from the address ${p.address ?? 'unknown'}` : 'for your username'
    }, the next attempt must wait ${duration(p.delaySeconds)}`,
  ],
  'owner.password_reset': (p) => [
    `Password reset with the server command; ${String(p.revokedSessions)} login session${p.revokedSessions === 1 ? '' : 's'} ended`,
  ],
  'session.created': () => ['Logged in'],
  'session.revoked': (p) => [p.reason === 'logout' ? 'Logged out' : 'Login session ended'],
  'github.token_saved': (p) => [
    `GitHub token saved for the account ${p.account}, `,
    p.expiresOn === null ? 'without expiry date' : `expires on ${formatDate(p.expiresOn)}`,
  ],
  'github.token_checked': (p) => {
    const missing = Object.entries(p.permissions)
      .filter(([, result]) => result !== 'ok')
      .map(([permission]) => permissionLabel(permission));
    return [
      missing.length === 0
        ? 'GitHub token checked: every permission is there'
        : `GitHub token checked: not confirmed: ${list(missing)}`,
    ];
  },
  'github.token_rejected': (p) => [
    `GitHub refused the token (${p.request}): enter a new token in Settings > GitHub`,
  ],
  'github.token_unreadable': () => [
    'The saved GitHub token can no longer be read (the secret key changed): enter it again in Settings > GitHub',
  ],
  'github.permission_refused': (p) => [
    `GitHub refused a request (${p.request}): the token needs ${list(p.permissions.map((each) => permissionLabel(each.split('=')[0] ?? each)))}`,
  ],
  'project.created': (p, c) => [
    c.project,
    ' created: ',
    quote(p.name, c.projectTo),
    `, ${kindLabel[p.kind].toLowerCase()}, ${p.origin === 'created' ? 'new' : 'linked'} ${p.private ? 'private' : 'public'} repository ${p.repository}`,
    p.requiredCapabilities && p.requiredCapabilities.length > 0
      ? `, requiring ${list(p.requiredCapabilities)}`
      : '',
  ],
  'project.updated': (p, c) => {
    const pieces: Piece[] = [c.project];
    if (p.name !== undefined) pieces.push(' renamed ', quote(p.name, c.projectTo));
    if (p.description !== undefined) {
      pieces.push(p.name === undefined ? ' description changed' : ', description changed');
    }
    return pieces;
  },
  'project.reviews_automatic_changed': (p, c) => [
    c.project,
    p.on
      ? ': Start reviews by themselves turned on'
      : ': Start reviews by themselves turned off, reviews wait for Start review',
  ],
  'project.merges_automatic_changed': (p, c) => [
    c.project,
    p.on
      ? ': Merge automatically turned on, approved pull requests are merged by the Orchestrator'
      : ': Merge automatically turned off, you merge pull requests on GitHub',
  ],
  'project.required_capabilities_changed': (p, c) => [
    c.project,
    `: required capabilities set to ${p.capabilities.length === 0 ? 'none' : list(p.capabilities)}`,
    p.previous.length === 0 ? ' (none before)' : ` (before: ${list(p.previous)})`,
  ],
  'project.setup_step': (p, c) => {
    const done: Record<typeof p.step, string> = {
      repository: p.reused
        ? `repository ${p.repository ?? ''} found, created by an earlier attempt`
        : `repository ${p.repository ?? ''} created`,
      skeleton: p.alreadyApplied ? 'starting files already there' : 'starting files added',
      branch_protection: `branch protection: ${
        p.branchProtection === undefined
          ? 'done'
          : branchProtectionLabel[p.branchProtection].toLowerCase()
      }`,
      harness:
        p.missing === undefined || p.missing.length === 0
          ? 'every harness element found'
          : `harness elements missing: ${list(p.missing.map((each) => harnessElement[each].label))}`,
    };
    return [c.project, ` setup: ${done[p.step]}`];
  },
  'project.setup_failed': (p, c) => [
    c.project,
    ` setup failed at “${stepLabel[p.step]}”: ${shorten(p.reason)}`,
  ],
  'project.setup_retried': (p, c) => [c.project, ' setup tried again'],
  'project.ready': (p, c) => [c.project, ' is ready'],
  'project.harness_checked': (p, c) => [
    c.project,
    p.missing.length === 0
      ? ' checked again: every harness element found'
      : ` checked again: missing ${list(p.missing.map((each) => harnessElement[each].label))}`,
  ],
  'project.archived': (p, c) => [c.project, ' archived'],
  'project.unarchived': (p, c) => [c.project, ' unarchived'],
  'project.pull_request_watch_failed': (p, c) => [
    c.project,
    `: ${p.pullRequests.length === 1 ? `pull request #${String(p.pullRequests[0] ?? 0)}` : `pull requests ${p.pullRequests.map((n) => `#${String(n)}`).join(', ')}`} could not be checked on GitHub — ${shorten(p.message)}`,
  ],
  'project.pull_request_watch_recovered': (p, c) => [
    c.project,
    ': its pull requests are checked on GitHub again',
  ],
  'tickets.imported': (p, c) => {
    const pieces: Piece[] = [
      c.project,
      `: ${String(p.count)} ticket${p.count === 1 ? '' : 's'} imported from a file: `,
    ];
    p.tickets.forEach((reference, index) => {
      if (index > 0) pieces.push(', ');
      pieces.push(ticketRefLink(reference));
    });
    return pieces;
  },
  'ticket.created': (p, c) => {
    const pieces: Piece[] = [
      c.ticket,
      ' created: ',
      quote(p.title, c.ticketTo),
      `, ${typeLabel[p.type].toLowerCase()}, ${priorityLabel[p.priority].toLowerCase()} priority, ${statusLabel[p.status].toLowerCase()}`,
    ];
    p.blockedBy.forEach((reference, index) => {
      pieces.push(index === 0 ? ', waits for ' : ', ', ticketRefLink(reference));
    });
    if (p.assigneeName !== undefined) pieces.push(', assigned to ', quote(p.assigneeName, null));
    if (p.agentName !== undefined) pieces.push(', proposed by agent ', quote(p.agentName, null));
    return pieces;
  },
  'ticket.updated': (p, c) => {
    const pieces: Piece[] = [
      c.ticket,
      ` edited: ${list(p.fields.map((field) => ticketFieldLabel[field] ?? field))}`,
    ];
    if (p.title !== undefined) pieces.push('; new title ', quote(p.title, c.ticketTo));
    if (p.assignee === null) pieces.push('; no assignee now');
    else if (p.assigneeName !== undefined) {
      pieces.push('; now assigned to ', quote(p.assigneeName, null));
    }
    return pieces;
  },
  'ticket.status_changed': (p, c) => {
    const said: Piece[] = c.comment === null ? [] : [': ', quote(c.comment, c.ticketTo)];
    switch (p.action) {
      case 'mark_done':
        return [c.ticket, ' marked as done manually', ...said];
      case 'cancel':
        return [c.ticket, ' cancelled'];
      case 'reopen':
        return [c.ticket, ` reopened: back to ${statusLabel[p.to].toLowerCase()}`];
      case 'run_now':
        return [c.ticket, ' in progress: Run now started a run'];
      case 'scheduler_started':
        return [c.ticket, ' in progress: the scheduler started a run'];
      case 'stop_run':
        return [c.ticket, ' back to to do: you stopped its run'];
      case 'run_submitted':
        return [c.ticket, ' in review: the agent finished and submitted its work'];
      case 'run_ended':
        return [
          c.ticket,
          ` back to to do: its run ended, ${p.failureReason ? failureText[p.failureReason] : 'without finishing'}`,
          p.attemptCounted === true
            ? ' (counted as a failed attempt)'
            : ' (not counted as a failed attempt)',
        ];
      case 'accept':
        return [c.ticket, ' accepted: the ticket an agent proposed is now to do'];
      case 'reject':
        return [c.ticket, ' rejected: the ticket an agent proposed is cancelled', ...said];
      case 'request_changes':
        return [c.ticket, ' sent back to to do: you requested changes', ...said];
      case 'question_asked':
        return [
          c.ticket,
          ' waits for you: ',
          ...(p.agentName === undefined ? ['the agent'] : ['agent ', quote(p.agentName, null)]),
          ' asked a question',
          ...said,
        ];
      case 'answered':
        return [c.ticket, ' in progress again: you answered the question'];
      case 'ci_checked_again':
        return [c.ticket, ' in review: Check CI again found the work accepted on GitHub'];
      case 'skip_review':
        return [c.ticket, ' awaiting merge: you skipped the review'];
      case 'review_answered':
        return [c.ticket, ' in review again: you answered the question'];
      case 'review_ended':
        return [c.ticket, ' in review again: its review run ended without a decision applied'];
      case 'review_approved':
        return [c.ticket, ' awaiting merge: Quality approved it'];
      case 'review_changes_requested':
        return [c.ticket, ' back to to do: Quality requested changes'];
      case 'pull_request_merged':
        return [c.ticket, ' done: its pull request was merged on GitHub', ...said];
    }
  },
  'ticket.dependency_added': (p, c) => [c.ticket, ' now waits for ', ticketRefLink(p.blockedBy)],
  'ticket.dependency_removed': (p, c) => [
    c.ticket,
    ' no longer waits for ',
    ticketRefLink(p.blockedBy),
  ],
  'ticket.commented': (p, c) => [
    c.ticket,
    c.comment === null ? ': comment added' : ': comment ',
    ...(c.comment === null ? [] : [quote(c.comment, c.ticketTo)]),
    ...(p.agentName === undefined ? [] : [' by agent ', quote(p.agentName, null)]),
  ],
  'ticket.submitted': (p, c) => [
    c.ticket,
    ': ',
    ...(p.agentName === undefined ? ['the agent'] : ['agent ', quote(p.agentName, null)]),
    ` submitted its work with every acceptance criterion reported met (${String(p.criteria)})`,
    ...(p.workflowChanges === true ? ['; it changes the GitHub workflows'] : []),
  ],
  'ticket.submission_refused': (p, c) => [
    c.ticket,
    ': the submission of ',
    ...(p.agentName === undefined ? ['the agent'] : ['agent ', quote(p.agentName, null)]),
    ` was refused by the checks (${p.failed.map((check) => checkLabel[check]).join(', ')})`,
  ],
  'ticket.pull_request_opened': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} opened on GitHub`,
    ...(p.notReopened === undefined
      ? []
      : [`, since GitHub refused to reopen the closed #${String(p.notReopened)}`]),
  ],
  'ticket.pull_request_reopened': (p, c) => [
    c.ticket,
    p.seen === true
      ? `: pull request #${String(p.number)} was reopened on GitHub`
      : p.owner === true
        ? `: pull request #${String(p.number)} reopened on GitHub`
        : `: pull request #${String(p.number)}, closed without merging, reopened on GitHub with the latest submission`,
  ],
  'ticket.pull_request_not_reopened': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} could not be reopened on GitHub — ${shorten(p.message)}`,
    ...(p.branchGone ? ['; its branch is gone from GitHub'] : []),
  ],
  'ticket.pull_request_conflict': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} conflicts with ${p.base} on GitHub (head ${p.head.slice(0, 7)})`,
  ],
  'ticket.pull_request_conflict_gone': (p, c) => [
    c.ticket,
    p.headMoved
      ? `: pull request #${String(p.number)}'s head moved since GitHub found it in conflict with ${p.base}`
      : `: pull request #${String(p.number)} no longer conflicts with ${p.base} on GitHub`,
  ],
  'ticket.pull_request_merged': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} was merged on GitHub`,
    p.outcome === 'done'
      ? `, into ${p.into}: the ticket is done`
      : p.outcome === 'already_done'
        ? `, into ${p.into}, after the ticket was marked as done`
        : p.outcome === 'cancelled'
          ? `, into ${p.into}: the ticket stays cancelled`
          : `, into ${p.into}, not the project's default branch: the ticket is unchanged`,
  ],
  'ticket.branch_deleted': (p, c) => [
    c.ticket,
    p.alreadyGone
      ? `: branch ${p.branch} was already gone from GitHub after the merge of pull request #${String(p.pullRequest)}`
      : `: branch ${p.branch} deleted on GitHub after the merge of pull request #${String(p.pullRequest)}`,
  ],
  'ticket.branch_kept': (p, c) => [
    c.ticket,
    `: branch ${p.branch} kept on GitHub: ${keptReasonText(p.reason, {
      ticket: p.ticket,
      pullRequest: p.pullRequest,
      mergedHead: p.head,
    })}`,
  ],
  'ticket.branch_pushed_again': (p, c) => [
    c.ticket,
    `: branch ${p.branch} is on GitHub again: ${p.machine} pushed ${p.head.slice(0, 7)} after its deletion; it is kept`,
  ],
  'ticket.machine_branch_deleted': (p, c) => [
    c.ticket,
    p.notFound === null
      ? `: branch ${p.branch} deleted on machine ${p.machine} after the merge of pull request #${String(p.pullRequest)}`
      : p.notFound === 'branch'
        ? `: machine ${p.machine} had no branch ${p.branch} left after the merge of pull request #${String(p.pullRequest)}`
        : `: machine ${p.machine} has no copy of the repository: no branch ${p.branch} to delete after the merge of pull request #${String(p.pullRequest)}`,
  ],
  'ticket.machine_branch_kept': (p, c) => [
    c.ticket,
    `: branch ${p.branch} kept on machine ${p.machine}: ${keptReasonText(p.reason, {
      ticket: p.ticket,
      pullRequest: p.pullRequest,
      mergedHead: p.head,
    })}`,
  ],
  'request.created': (p, c) => [
    requestLink(p.request),
    ...(p.project === null
      ? [' submitted for a new project: ']
      : [' submitted for ', c.project, ': ']),
    quote(p.line, requestPath(p.request)),
  ],
  'request.commented': (p, c) => [
    requestLink(p.request),
    c.comment === null ? ': comment added' : ': comment ',
    ...(c.comment === null ? [] : [quote(c.comment, requestPath(p.request))]),
    ...(p.agentName === undefined ? [] : [' by agent ', quote(p.agentName, null)]),
  ],
  'request.status_changed': (p) =>
    p.cause === 'run_started'
      ? [requestLink(p.request), ': planning, a planning run started']
      : [
          requestLink(p.request),
          ` back to ${requestStatusLabel[p.to].toLowerCase()}: its planning run ended, ${p.failureReason ? failureText[p.failureReason] : 'without a plan'} (not counted as a failed attempt)`,
        ],
  'ticket.pull_request_closed': (p, c) => [
    c.ticket,
    p.by === 'orchestrator'
      ? `: pull request #${String(p.number)} closed on GitHub without merging, since the ticket was cancelled`
      : `: pull request #${String(p.number)} was closed on GitHub without merging`,
  ],
  'ticket.pull_request_not_closed': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} could not be closed on GitHub after the cancellation — ${shorten(p.message)}`,
  ],
  'ticket.pull_request_updated': (p, c) => [
    c.ticket,
    `: pull request #${String(p.number)} updated on GitHub with the latest submission`,
  ],
  'ticket.pull_request_not_opened': (p, c) => [
    c.ticket,
    p.openPullRequest === undefined
      ? `: the pull request could not be opened or updated on GitHub — ${shorten(p.message)}`
      : p.openPullRequest === null
        ? `: the pull request could not be opened on GitHub — ${shorten(p.message)}`
        : `: pull request #${String(p.openPullRequest)} could not be updated on GitHub — ${shorten(p.message)}`,
  ],
  'ticket.merged_automatically': (p, c) => [
    c.ticket,
    `: pull request #${String(p.pullRequest)} merged automatically with commit ${p.commit.slice(0, 7)}, approved by Quality (squash)`,
  ],
  'ticket.automatic_merge_failed': (p, c) => [
    c.ticket,
    `: pull request #${String(p.pullRequest)} not merged automatically — ${shorten(p.message)}`,
  ],
  'ticket.review_posted': (p, c) => [
    c.ticket,
    `: Quality's review of commit ${p.commit.slice(0, 7)} posted on pull request #${String(p.pullRequest)} on GitHub`,
  ],
  'ticket.review_not_posted': (p, c) => {
    const review = `Quality's review of commit ${p.commit.slice(0, 7)}`;
    const pull = `pull request #${String(p.pullRequest)}`;
    const why = p.message === null ? '' : ` — ${shorten(p.message)}`;
    switch (p.outcome) {
      case 'not_posted':
        return [c.ticket, `: ${review} not posted on ${pull}; the decision stands${why}`];
      case 'not_found':
        return [
          c.ticket,
          `: GitHub did not answer the post of ${review}, and it was not on ${pull} when checked; the decision stands`,
        ];
      case 'not_checked':
        return [
          c.ticket,
          `: GitHub did not answer the post of ${review}, and ${pull} could not be checked; the decision stands${why}`,
        ];
    }
  },
  'ticket.stopped': (p, c) => [
    c.ticket,
    p.cause === 'review_rounds'
      ? `: stopped after ${String(p.count)} requests for changes by Quality (Most review rounds per ticket: ${String(p.limit)})`
      : `: stopped after ${String(p.count)} failed attempt${p.count === 1 ? '' : 's'} (Failed attempts before asking you: ${String(p.limit)})`,
  ],
  'ticket.tried_again': (_p, c) => [c.ticket, ': you used Try again; its counts start again'],
  'ticket.held': (p, c) => [
    c.ticket,
    p.cause === 'request_changes'
      ? ': held so you can edit its acceptance criteria first; the scheduler does not start the fix until you use Run now'
      : p.cause === 'stop_review'
        ? ': held after you stopped its review; the scheduler does not start it again until you use Start review'
        : ': held after you stopped its run; the scheduler does not start it again until you use Run now',
  ],
  'ticket.released': (p, c) => [c.ticket, `: no longer held, ${releaseText[p.action]}`],
  'ticket.could_not_start': (p, c) => [
    c.ticket,
    `: could not start on ${p.machine}, ${String(p.count)} failure${p.count === 1 ? '' : 's'} in a row caused by the machine (${p.causes.map((cause) => machineFailureText[cause]).join('; ')}); it waits for you in Needs you (Machine failures before asking you: ${String(p.limit)})`,
  ],
  'ticket.ci_checked_again': (p, c) => {
    const commit = p.commit === '' ? '' : ` for commit ${p.commit.slice(0, 7)}`;
    switch (p.outcome) {
      case 'accepted':
        return [
          c.ticket,
          `: you checked CI again${commit}; ${p.state === 'no_ci' ? 'no CI found' : 'CI passed'}, the work accepted without a session${p.attemptTakenBack === true ? ' and its failed attempt taken back' : ''}`,
        ];
      case 'not_finished':
        return [c.ticket, `: you checked CI again${commit}; it had still not finished`];
      case 'failed':
        return [c.ticket, `: you checked CI again${commit}; it had failed, nothing changed`];
      case 'conflict':
        return [
          c.ticket,
          `: you checked CI again${commit}; the pull request conflicts with its base branch`,
        ];
      case 'github_problem':
        return [
          c.ticket,
          `: you checked CI again${commit}; GitHub could not be checked — ${shorten(p.message ?? '')}`,
        ];
      case 'refused':
        return [c.ticket, `: Check CI again refused — ${shorten(p.message ?? '')}`];
    }
  },
  'setting.changed': (p, c) => {
    const { label } = SETTINGS[p.name];
    if (p.scope === 'project') {
      return [
        `${label} set to ${amount(p.name, p.value)} for `,
        c.project,
        p.previous === null ? ' (was the global value)' : ` (was ${amount(p.name, p.previous)})`,
      ];
    }
    return [
      `${label} set to ${amount(p.name, p.value)} (was ${
        p.previous === null ? 'the default' : amount(p.name, p.previous)
      })`,
    ];
  },
  'setting.reset': (p, c) => {
    const { label } = SETTINGS[p.name];
    if (p.scope === 'project') {
      return [`${label}: the override for `, c.project, ' was removed, the global value applies'];
    }
    return [`${label} reset to its default, ${amount(p.name, SETTINGS[p.name].default)}`];
  },
  'account.created': (p) => [
    'Claude account ',
    quote(p.label, null),
    ` added: ${planLabel[p.plan]} plan, ${concurrentRuns(p.maxConcurrentRuns)}`,
  ],
  'account.updated': (p) => {
    const changes: string[] = [];
    if (p.previousLabel !== undefined) changes.push(`renamed from “${shorten(p.previousLabel)}”`);
    if (p.plan !== undefined) changes.push(`${planLabel[p.plan]} plan`);
    if (p.maxConcurrentRuns !== undefined) changes.push(concurrentRuns(p.maxConcurrentRuns));
    if (p.schedule !== undefined) changes.push(`windows: ${scheduleText(p.schedule)}`);
    if (p.dailyBudget !== undefined) changes.push(`daily budget: ${budgetText(p.dailyBudget)}`);
    return ['Claude account ', quote(p.label, null), ` edited: ${list(changes)}`];
  },
  'account.limited': (p) => [
    'Claude account ',
    quote(p.label, null),
    ` reached its usage limit: no run starts on it until ${formatDateTime(p.until)}`,
    p.source === 'fallback'
      ? ` (the reset time was not known: ${duration((p.fallbackMinutes ?? 0) * 60)} from then)`
      : '',
  ],
  'account.available': (p) => [
    'Claude account ',
    quote(p.label, null),
    ' available again: its usage limit time has passed',
  ],
  'account.quota_wait_restarted': (p) => [
    'Claude account ',
    quote(p.label, null),
    `: a run worked again without reaching the usage limit, so the next limit without a reset time waits Quota wait when the reset time is unknown again (the latest wait was ${duration(p.minutes * 60)})`,
  ],
  'account.paused': (p) => [
    'New runs stopped on the Claude account ',
    quote(p.label, null),
    p.activeRuns === 0
      ? ''
      : `: ${String(p.activeRuns)} active run${p.activeRuns === 1 ? '' : 's'} go${p.activeRuns === 1 ? 'es' : ''} on and finish${p.activeRuns === 1 ? 'es' : ''}`,
  ],
  'account.resumed': (p) => [
    'Claude account ',
    quote(p.label, null),
    ' resumed',
    p.limitedUntil === undefined
      ? ''
      : `: its usage limit still holds until ${formatDateTime(p.limitedUntil)}`,
  ],
  'setting.time_zone_saved': (p) => [
    `Time zone set to ${p.timeZone} (was ${p.previous ?? 'not set: UTC'})`,
  ],
  'machine.created': (p) => [
    'Machine ',
    quote(p.name, null),
    ' added, using the Claude account ',
    quote(p.account, null),
  ],
  'machine.enrollment_code_created': (p) => [
    'Enrollment code created for the machine ',
    quote(p.name, null),
    `, valid until ${formatDateTime(p.expiresAt)}`,
  ],
  'machine.enrolled': (p) => [
    'Machine ',
    quote(p.name, null),
    ' enrolled: its daemon got its token',
  ],
  'machine.enrollment_throttled': (p) => [
    `After ${String(p.failures)} wrong enrollment codes from the address ${p.address}, the next attempt must wait ${duration(p.delaySeconds)}`,
  ],
  'machine.online': (p) => {
    const problems = p.unusable.map((reason) =>
      reason === 'claude_code_unsupported'
        ? 'its Claude Code version is not supported'
        : reason === 'daemon_outdated'
          ? 'its daemon is older than this Orchestrator'
          : 'doctor found a problem',
    );
    return [
      'Machine ',
      quote(p.name, null),
      ` connected: daemon ${p.daemonVersion}${
        p.daemonBuild
          ? ` (build ${p.daemonBuild}${p.buildDiffers ? ', not the one provided' : ''})`
          : ''
      }, ${
        p.claudeCodeVersion === null
          ? 'Claude Code not found'
          : `Claude Code ${p.claudeCodeVersion}`
      }, detected ${p.detected.length === 0 ? 'nothing' : list(p.detected)}`,
      problems.length === 0 ? '' : `. It cannot receive runs: ${list(problems)}`,
    ];
  },
  'machine.offline': (p) => {
    const why: Record<typeof p.reason, string> = {
      connection_closed: 'its connection closed',
      silent: 'nothing received from it in time',
      server_restarted: 'the Orchestrator restarted, waiting for it to reconnect',
      revoked: 'revoked',
    };
    return ['Machine ', quote(p.name, null), ` offline: ${why[p.reason]}`];
  },
  'machine.daemon_incompatible': (p) => [
    'Machine ',
    quote(p.name, null),
    ` refused: its daemon ${p.daemonVersion} speaks protocol version ${String(p.protocolVersion)}, which this Orchestrator does not accept. Install the daemon of this Orchestrator's version`,
  ],
  'machine.disabled': (p) => ['Machine ', quote(p.name, null), ' disabled: it gets no new runs'],
  'machine.enabled': (p) => ['Machine ', quote(p.name, null), ' enabled again'],
  'machine.revoked': (p) => [
    'Machine ',
    quote(p.name, null),
    ' revoked: its daemon was disconnected and its token no longer works',
  ],
  'machine.claude_code_unsupported': (p) => [
    'Machine ',
    quote(p.name, null),
    ` cannot receive runs: a run found ${
      p.version === null ? 'no Claude Code' : `Claude Code ${p.version}`
    }, and ${p.minimum} or later is needed`,
  ],
  'machine.doctor_changed': (p) => [
    'Machine ',
    quote(p.name, null),
    p.errors.length === 0
      ? ': its checks changed, none reports an error'
      : ` cannot receive runs: its checks found a problem (${list(p.errors)})`,
  ],
  'machine.capabilities_changed': (p) => [
    'Capabilities of the machine ',
    quote(p.name, null),
    ` set to ${p.capabilities.length === 0 ? 'none' : list(p.capabilities)}`,
  ],
  'agent_profile.created': (p) => [
    'Agent profile ',
    quote(p.name, null),
    ` added, version ${String(p.version)}`,
  ],
  'agent_profile.updated': (p) => [
    'Agent profile ',
    quote(p.name, null),
    ` updated with the Orchestrator: version ${String(p.previousVersion)} to ${String(p.version)}`,
  ],
  'run.created': (p, c) => [
    `Attempt ${String(p.attempt)} at `,
    c.ticket,
    ' started by ',
    quote(p.profileName, null),
    ` (version ${String(p.profileVersion)}) on machine `,
    quote(p.machine, null),
    ', Claude account ',
    quote(p.account, null),
  ],
  'run.status_changed': (p, c) => {
    const why =
      p.failureReason !== undefined
        ? `: ${failureText[p.failureReason]}`
        : p.pauseReason !== undefined
          ? `: ${pauseText[p.pauseReason]}`
          : '';
    return [
      'Run of ',
      c.ticket,
      ` on `,
      quote(p.machine, null),
      `: ${runStatusLabel[p.from].toLowerCase()} to ${runStatusLabel[p.to].toLowerCase()} (${causeText[p.cause]})${why}`,
      p.resumeAt === undefined
        ? ''
        : `; the scheduler resumes it at ${formatDateTime(p.resumeAt)}, ${duration((p.quotaWaitMinutes ?? 0) * 60)} later`,
      p.detail === undefined ? '' : ` — ${shorten(p.detail)}`,
    ];
  },
  'run.progress': (p, c) => ['Run of ', c.ticket, ': ', quote(p.text, null)],
  'run.git_config_restored': (p, c) => [
    'Run of ',
    c.ticket,
    ' on ',
    quote(p.machine, null),
    `: at its end, the Git configuration of ${p.repository} on that machine was found changed and restored (information only) — ${shorten(p.changes)}`,
  ],
  'run.branch_pushed': (p, c) => [
    'Run of ',
    c.ticket,
    ' on ',
    quote(p.machine, null),
    `: branch ${p.branch} pushed to GitHub ${pushMoment[p.at]} (latest commit ${p.head.slice(0, 7)})`,
  ],
  'run.branch_push_failed': (p, c) => [
    'Run of ',
    c.ticket,
    ' on ',
    quote(p.machine, null),
    `: the push of branch ${p.branch} to GitHub ${pushMoment[p.at]} failed; its new commits stay on that machine — ${shorten(p.message)}`,
  ],
  'run.ci_waiting': (p, c) => [
    'Run of ',
    c.ticket,
    `: waiting for CI on GitHub for the submitted commit ${p.commit.slice(0, 7)}${p.pullRequest === null ? '' : ` (pull request #${String(p.pullRequest)})`}`,
  ],
  'run.ci_result': (p, c) => ['Run of ', c.ticket, ciResultText(p)],
  'run.ci_check_failed': (p, c) => [
    'Run of ',
    c.ticket,
    `: CI could not be checked, ${ciCheckFailureWords[p.reason]}; the run keeps waiting until "CI wait at submission" — ${shorten(p.message)}`,
  ],
  'run.ci_check_recovered': (_p, c) => [
    'Run of ',
    c.ticket,
    ': CI could be checked on GitHub again',
  ],
  'run.ci_round_sent': (p, c) => [
    'Run of ',
    c.ticket,
    p.kind === 'failed'
      ? `: CI failed on GitHub for the submitted commit ${p.commit.slice(0, 7)}; the failure was sent to the agent to fix (${String(p.round)} of ${String(p.of)} allowed in this run)`
      : `: the pull request of the submitted commit ${p.commit.slice(0, 7)} conflicts with the default branch; the agent was told to merge it (${String(p.round)} of ${String(p.of)} allowed in this run)`,
  ],
  'run.review_decided': (p, c) => [
    'Run of ',
    c.ticket,
    `: Quality ${p.decision === 'approved' ? 'approved' : `requested changes (${String(p.points)} point${p.points === 1 ? '' : 's'}) on`} commit ${p.commit.slice(0, 7)}; it applies when the review run ends`,
    ...(p.headChecked ? [] : [" (the pull request's head could not be checked on GitHub)"]),
  ],
  'run.review_discarded': (p, c) => [
    'Run of ',
    c.ticket,
    ` on ${p.machine}: Quality's ${p.decision === 'approved' ? 'approval' : 'request for changes'} of commit ${p.commit.slice(0, 7)} was not applied, because the review run ended first${p.failureReason ? ` (${failureText[p.failureReason]})` : ''}`,
  ],
  'run.ci_round_not_taken': (p, c) => [
    'Run of ',
    c.ticket,
    `: ${p.kind === 'failed' ? 'the CI failure' : 'the conflict'} of the submitted commit ${p.commit.slice(0, 7)} could not be sent to the agent yet; the Orchestrator tries again at each check — ${shorten(p.message)}`,
  ],
};

const pushMoment = { submission: 'at the submission', end: "at the run's end" } as const;

const ciCheckFailureWords: Record<CiCheckFailureReason, string> = {
  unreachable: 'GitHub could not be reached',
  rate_limited: "GitHub's request limit was reached",
  unreadable: "GitHub's answer could not be read",
  token: 'the GitHub token cannot be used',
  permission_missing: 'the GitHub token lacks a permission',
  refused: 'GitHub refused the request',
};

/** The CI result in words (lot 3 step G1a), with the workflow flag beside "No CI found". */
function ciResultText(p: EventPayload<'run.ci_result'>): string {
  const commit = `the submitted commit ${p.commit.slice(0, 7)}`;
  const checks = `${String(p.checks)} check${p.checks === 1 ? '' : 's'}`;
  const result = {
    passed: `CI passed on GitHub for ${commit} (${checks})`,
    no_ci: `no CI found on GitHub for ${commit}: no CI run or status appeared within "Wait for CI to start"${
      p.workflowChanges === 'changed'
        ? '. This submission also changed workflow files, so the agent may have removed or weakened CI: look at the changed files of the pull request before merging'
        : p.workflowChanges === 'not_listed'
          ? '. This submission may also have changed workflow files (its list of changed files was not complete), so CI may have been removed: look at the changed files of the pull request before merging'
          : ''
    }`,
    failed: `CI failed on GitHub for ${commit} (failed: ${p.failed.join(', ') || 'none named'})`,
    conflict: `the pull request conflicts with ${p.baseBranch}, so GitHub started no CI for ${commit}: the submission does not pass`,
  }[p.state];
  const moved =
    p.pullRequestHead === null
      ? ''
      : `. The pull request's latest commit is now ${p.pullRequestHead.slice(0, 7)}: this result is the submitted commit's`;
  return `: ${result}${moved}`;
}

function run(type: EventType, payload: unknown, context: Context): Piece[] | null {
  const parsed = EventPayloads[type].safeParse(payload);
  // The payload was parsed with this type's schema, so it is the one its text expects.
  const text = describe[type] as Describe<EventType>;
  return parsed.success ? text(parsed.data, context) : null;
}

/** The event in plain words (02, section 7), with links to its project or ticket. */
export function eventText(entry: EventLogEntry): Piece[] {
  const payload = entry.payload ?? {};
  const key =
    entry.project?.key ??
    (typeof payload.key === 'string' ? payload.key : null) ??
    (typeof payload.project === 'string' ? payload.project : null) ??
    (typeof payload.projectKey === 'string' ? payload.projectKey : null);
  const projectTo = entry.project ? projectPath(entry.project.key) : null;
  const ticketTo =
    entry.project && entry.ticket ? ticketPath(entry.project.key, entry.ticket.number) : null;
  const reference =
    entry.project && entry.ticket
      ? `${entry.project.key}-${String(entry.ticket.number)}`
      : typeof payload.ticket === 'string'
        ? payload.ticket
        : 'A ticket';
  const context: Context = {
    project: projectTo === null ? (key ?? 'A project') : { text: key ?? '', to: projectTo },
    projectTo,
    ticket: ticketTo === null ? reference : { text: reference, to: ticketTo },
    ticketTo,
    comment: entry.comment,
  };
  const described = entry.payload === null ? null : run(entry.type, entry.payload, context);
  if (described !== null) return described;
  // A payload that does not match its type: the type in plain words, and what it concerns.
  const about = entry.entityType === 'ticket' ? context.ticket : key ? context.project : null;
  return about === null ? [eventTypeLabel[entry.type]] : [eventTypeLabel[entry.type], ': ', about];
}

/** The text without links, for tests and accessible names. */
export function plainText(pieces: Piece[]): string {
  return pieces.map((piece) => (typeof piece === 'string' ? piece : piece.text)).join('');
}
