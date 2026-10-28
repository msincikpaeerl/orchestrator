import {
  FIRST_MESSAGE_MAX_BYTES,
  type ProjectKind,
  type TicketStatus,
  type TicketType,
} from '@orchestrator/protocol';
import type { Template } from './files.js';
import {
  FirstMessageTooLarge,
  fill,
  part,
  timestamp,
  type FirstMessageComment,
} from './messages.js';

// The first message of a `plan` run (03, section 3.1; owner's answer 5, lot 5 step E1): the
// request, its conversation, the project and its tickets (or "no project yet"), the agents that
// can be assigned, the plan's limit, and after a rejection the earlier plan and the owner's
// feedback, from the template `plan`. Like the other first messages, within
// `FIRST_MESSAGE_MAX_BYTES`.

/** A ticket of the project, in one line. */
export interface PlanProjectTicket {
  /** `WEB-12`. */
  reference: string;
  status: TicketStatus;
  type: TicketType;
  /** The assignee's profile key, or null. */
  assignee: string | null;
  title: string;
}

/** Layer 3 of 03, section 3, for a `plan` run. */
export interface PlanRequest {
  number: number;
  body: string;
  /** Oldest first. */
  comments: readonly FirstMessageComment[];
  /** The request's project, or null for a request that asks for a new one. */
  project: {
    name: string;
    key: string;
    kind: ProjectKind;
    /** The base branch the folder holds, as GitHub has it. */
    base: string;
    /** Its tickets but the cancelled ones, in number order. */
    tickets: readonly PlanProjectTicket[];
  } | null;
  /** The profiles that can be assigned a ticket. */
  agents: readonly { key: string; name: string; description: string }[];
  /** **Most tickets per plan** for the project (the global value for a new one). */
  maxTicketsPerPlan: number;
  /** This run's attempt at the request, from 1. */
  attempt: number;
  /** After **Reject with feedback**: the rejected plan and the owner's feedback, never cut. */
  rejected: {
    summary: string;
    tickets: readonly { key: string; title: string }[];
    feedback: string;
  } | null;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** The largest count from 0 to `most` for which `ok` holds, `ok` holding for every smaller one. */
function largest(most: number, ok: (count: number) => boolean): number {
  let low = 0;
  let high = most;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ok(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The first message of a `plan` run within `maxBytes` (owner's answer 5, lot 5 step E1). While it
 * is too long, in this order: the oldest comments go (those kept are shown oldest first); then the
 * project's tickets, the done ones first and then the oldest others; then the rejected plan's
 * tickets from the last; then the request's text is cut at a line boundary. The owner's feedback
 * is never cut. Each cut says what was left out and, where one does, which tool returns it.
 */
export function planFirstMessage(
  template: Template,
  request: PlanRequest,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const renderedComments = request.comments.map((comment) =>
    part(template, 'comment', {
      author:
        comment.author.kind === 'agent'
          ? part(template, 'author-agent', { name: comment.author.name })
          : part(template, `author-${comment.author.kind}`),
      kind: comment.kind,
      at: timestamp(comment.at),
      body: comment.body.trim(),
    }),
  );
  const tickets = request.project?.tickets ?? [];
  // The order the project's tickets leave the message in: the done ones, then the oldest others.
  const leaving = [
    ...tickets.filter((ticket) => ticket.status === 'done'),
    ...tickets.filter((ticket) => ticket.status !== 'done'),
  ];
  const rejectedTickets = request.rejected?.tickets ?? [];
  const agents = request.agents
    .map((agent) =>
      part(template, 'agent', {
        key: agent.key,
        name: agent.name,
        description: agent.description.trim(),
      }),
    )
    .join('\n');

  const ticketLines = (kept: number) => {
    const shown = new Set(leaving.slice(leaving.length - kept));
    const line = (ticket: PlanProjectTicket) =>
      part(template, 'ticket', {
        ticket: ticket.reference,
        status: ticket.status,
        type: ticket.type,
        assignee: ticket.assignee ?? part(template, 'no-assignee'),
        title: ticket.title,
      });
    const lines = [
      ...tickets.filter((ticket) => ticket.status !== 'done' && shown.has(ticket)),
      ...tickets.filter((ticket) => ticket.status === 'done' && shown.has(ticket)),
    ].map(line);
    if (tickets.length === 0) return part(template, 'no-tickets');
    const leftOut = tickets.length - kept;
    return [
      ...lines,
      ...(leftOut > 0 ? [part(template, 'tickets-left-out', { count: String(leftOut) })] : []),
    ].join('\n');
  };

  const rejection = (kept: number) => {
    if (request.rejected === null) return '';
    const leftOut = rejectedTickets.length - kept;
    return part(template, 'rejection', {
      summary: request.rejected.summary.trim(),
      tickets: [
        ...rejectedTickets
          .slice(0, kept)
          .map((ticket) => part(template, 'rejected-ticket', ticket)),
        ...(leftOut > 0
          ? [part(template, 'rejected-tickets-left-out', { count: String(leftOut) })]
          : []),
      ].join('\n'),
      feedback: request.rejected.feedback.trim(),
    });
  };

  const project = request.project;
  const render = (state: { comments: number; tickets: number; rejected: number; body: string }) => {
    const leftOut = renderedComments.length - state.comments;
    const comments =
      renderedComments.length === 0
        ? part(template, 'no-comments')
        : [
            ...(leftOut > 0
              ? [part(template, 'comments-left-out', { count: String(leftOut) })]
              : []),
            ...renderedComments.slice(leftOut),
          ].join('\n\n');
    return `${fill(template, template.main, {
      request: String(request.number),
      for:
        project === null
          ? part(template, 'for-new-project')
          : part(template, 'for-project', { project_name: project.name, key: project.key }),
      attempt: String(request.attempt),
      body: state.body,
      comments,
      project:
        project === null
          ? part(template, 'new-project')
          : part(template, 'project', {
              project_name: project.name,
              key: project.key,
              kind: project.kind,
              base: project.base,
              tickets: ticketLines(state.tickets),
            }),
      agents,
      max_tickets: String(request.maxTicketsPerPlan),
      rejection: rejection(state.rejected),
    })}\n`;
  };
  const fits = (text: string) => bytes(text) <= maxBytes;

  const body = request.body.trim();
  const full = {
    comments: renderedComments.length,
    tickets: tickets.length,
    rejected: rejectedTickets.length,
    body,
  };
  const comments = largest(renderedComments.length, (count) =>
    fits(render({ ...full, comments: count })),
  );
  if (fits(render({ ...full, comments }))) return render({ ...full, comments });
  const none = { ...full, comments: 0 };
  const keptTickets = largest(tickets.length, (count) => fits(render({ ...none, tickets: count })));
  if (fits(render({ ...none, tickets: keptTickets }))) {
    return render({ ...none, tickets: keptTickets });
  }
  const bare = { ...none, tickets: 0 };
  const keptRejected = largest(rejectedTickets.length, (count) =>
    fits(render({ ...bare, rejected: count })),
  );
  if (fits(render({ ...bare, rejected: keptRejected }))) {
    return render({ ...bare, rejected: keptRejected });
  }

  // Still too long: cut the request's text at a line boundary.
  const least = { ...bare, rejected: 0 };
  const lines = body.split('\n');
  const cut = (count: number) =>
    [lines.slice(0, count).join('\n').trimEnd(), part(template, 'body-cut')]
      .filter((text) => text !== '')
      .join('\n\n');
  const keptLines = largest(lines.length - 1, (count) =>
    fits(render({ ...least, body: cut(count) })),
  );
  const message = render({ ...least, body: cut(keptLines) });
  if (!fits(message)) throw new FirstMessageTooLarge(`request ${String(request.number)}`);
  return message;
}
