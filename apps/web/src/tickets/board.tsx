import {
  TicketType,
  type Project,
  type TicketStatus,
  type TicketSummary,
} from '@orchestrator/protocol';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { buttonLinkClass, ErrorMessage, Loading, SelectField, TextField } from '../components/ui';
import { useAgents, useTickets } from '../queries';
import { cardRunText } from '../runs/text';
import { assigneeLabel, showsBlocked, statusLabel, ticketPath, ticketRef, typeLabel } from './text';

/**
 * Columns shown open, in the order of 04, section 1. `proposed` is hidden (02, section 6.3),
 * except for the tickets agents proposed, shown in a "Proposed" column whenever there is one; the
 * toggle for plan tickets comes with plans (lot 5).
 */
const OPEN_COLUMNS: readonly TicketStatus[] = [
  'todo',
  'in_progress',
  'waiting_human',
  'in_review',
  'awaiting_merge',
];
/** Columns shown collapsed (02, section 6.3). */
const COLLAPSED_COLUMNS: readonly TicketStatus[] = ['done', 'cancelled'];

export function BlockedBadge() {
  return <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-900">Blocked</span>;
}

function TicketCard({ ticket }: { ticket: TicketSummary }) {
  return (
    <li className="rounded border border-slate-200 bg-white p-3 shadow-sm">
      <Link
        to={ticketPath(ticket.projectKey, ticket.number)}
        className="block font-medium break-words text-blue-700 underline"
      >
        {ticketRef(ticket.projectKey, ticket.number)} · {ticket.title}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <span>{typeLabel[ticket.type]}</span>
        <span className={ticket.assignee ? undefined : 'text-slate-500'}>
          · {assigneeLabel(ticket.assignee)}
        </span>
        {showsBlocked(ticket) && <BlockedBadge />}
        {ticket.createdByAgent && (
          <span className="rounded bg-violet-100 px-2 py-0.5 text-sm text-violet-900">
            created by agent
          </span>
        )}
      </div>
      {ticket.activeRun && <RunIndicator run={ticket.activeRun} />}
    </li>
  );
}

/** The card's active run indicator, with the last progress line (02, section 6.3). */
function RunIndicator({ run }: { run: NonNullable<TicketSummary['activeRun']> }) {
  const { status, progress } = cardRunText(run);
  const look =
    run.status === 'paused_quota' || run.status === 'waiting_human'
      ? 'bg-amber-50 text-amber-900'
      : 'bg-green-50 text-green-900';
  return (
    <div className={`mt-2 rounded px-2 py-1 text-sm ${look}`} aria-label="Active run">
      <p className="font-medium">{status}</p>
      {progress && <p className="break-words">{progress}</p>}
    </div>
  );
}

function CardList({ status, tickets }: { status: TicketStatus; tickets: TicketSummary[] }) {
  return tickets.length === 0 ? (
    <p className="text-sm text-slate-600">No tickets</p>
  ) : (
    <ul aria-label={statusLabel[status]} className="space-y-2">
      {tickets.map((ticket) => (
        <TicketCard key={ticket.id} ticket={ticket} />
      ))}
    </ul>
  );
}

function Column({ status, tickets }: { status: TicketStatus; tickets: TicketSummary[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-2 rounded-lg bg-slate-100 p-3">
      <h3 id={id} className="font-semibold text-slate-900">
        {statusLabel[status]} ({tickets.length})
      </h3>
      <CardList status={status} tickets={tickets} />
    </section>
  );
}

function CollapsedColumn({ status, tickets }: { status: TicketStatus; tickets: TicketSummary[] }) {
  return (
    <details className="min-w-0 rounded-lg bg-slate-100 p-3">
      <summary className="cursor-pointer font-semibold text-slate-900">
        {statusLabel[status]} ({tickets.length})
      </summary>
      <div className="mt-2">
        <CardList status={status} tickets={tickets} />
      </div>
    </details>
  );
}

/** The text filter matches the number (`WEB-12`, `12`) or the title. */
function matches(ticket: TicketSummary, text: string): boolean {
  const words = text.trim().toLowerCase();
  if (words === '') return true;
  const ref = ticketRef(ticket.projectKey, ticket.number).toLowerCase();
  return (
    ref === words ||
    String(ticket.number) === words ||
    ticket.title.toLowerCase().includes(words) ||
    ref.includes(words)
  );
}

/** The assignee filter: every ticket, the unassigned ones, or one profile's. */
const ALL = '';
const UNASSIGNED = '-';

function matchesAssignee(ticket: TicketSummary, filter: string): boolean {
  if (filter === ALL) return true;
  if (filter === UNASSIGNED) return ticket.assignee === null;
  return ticket.assignee?.key === filter;
}

/**
 * Project board (02, section 6.3): columns by state, `done` and `cancelled` collapsed, `proposed`
 * hidden. Columns sit side by side on a wide screen and one below the other on a
 * phone, so nothing scrolls sideways (owner's decision, lot 1 step F).
 */
export function Board({ project }: { project: Project }) {
  const tickets = useTickets(project.key);
  const agents = useAgents();
  const [type, setType] = useState<TicketType | ''>('');
  const [assignee, setAssignee] = useState(ALL);
  const [text, setText] = useState('');
  const canCreate = project.status === 'active' && project.setup.status === 'ready';

  if (tickets.isPending) return <Loading />;
  if (tickets.isError) {
    return <ErrorMessage>The tickets could not be loaded. Reload the page.</ErrorMessage>;
  }
  const all = tickets.data.tickets;
  const shown = all.filter(
    (ticket) =>
      (type === '' || ticket.type === type) &&
      matchesAssignee(ticket, assignee) &&
      matches(ticket, text),
  );
  const inState = (status: TicketStatus) => shown.filter((ticket) => ticket.status === status);
  // Tickets proposed by agents: the column shows whenever one exists, even filtered out.
  const proposedByAgents = all.some(
    (ticket) => ticket.status === 'proposed' && ticket.createdByAgent !== null,
  );
  const openColumns: readonly TicketStatus[] = proposedByAgents
    ? ['proposed', ...OPEN_COLUMNS]
    : OPEN_COLUMNS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        {canCreate && (
          <Link to={`/projects/${project.key}/tickets/new`} className={buttonLinkClass}>
            New ticket
          </Link>
        )}
        {all.length > 0 && (
          <>
            <div className="w-full sm:w-48">
              <SelectField
                label="Type"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as TicketType | '');
                }}
              >
                <option value="">All types</option>
                {TicketType.options.map((each) => (
                  <option key={each} value={each}>
                    {typeLabel[each]}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="w-full sm:w-48">
              <SelectField
                label="Assignee"
                value={assignee}
                onChange={(event) => {
                  setAssignee(event.target.value);
                }}
              >
                <option value={ALL}>All assignees</option>
                <option value={UNASSIGNED}>Unassigned</option>
                {(agents.data?.agents ?? []).map((agent) => (
                  <option key={agent.key} value={agent.key}>
                    {agent.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="w-full sm:w-64">
              <TextField
                label="Search"
                type="search"
                placeholder="Number or words of the title"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
              />
            </div>
          </>
        )}
      </div>
      {all.length === 0 ? (
        <p className="text-slate-700">
          No tickets yet.
          {canCreate && (
            <>
              {' '}
              Click <strong>New ticket</strong> to write the first one.
            </>
          )}
        </p>
      ) : (
        <>
          <div
            className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${proposedByAgents ? 'xl:grid-cols-6' : 'xl:grid-cols-5'}`}
          >
            {openColumns.map((status) => (
              <Column
                key={status}
                status={status}
                tickets={inState(status).filter(
                  (ticket) => status !== 'proposed' || ticket.createdByAgent !== null,
                )}
              />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {COLLAPSED_COLUMNS.map((status) => (
              <CollapsedColumn key={status} status={status} tickets={inState(status)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
