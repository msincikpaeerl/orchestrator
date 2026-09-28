import {
  AddCommentRequest,
  AddDependencyRequest,
  EDITABLE_STATUSES,
  MarkDoneRequest,
  OWNER_TRANSITIONS,
  RejectRequest,
  Run,
  TicketDetail,
  type OwnerTicketAction,
  type Project,
  type TicketLink,
  type TimelineEntry,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiRequestError } from '../api';
import { UntrustedMarkdown } from '../components/markdown';
import {
  Button,
  Card,
  ConfirmDialog,
  ErrorMessage,
  HelpLink,
  InfoMessage,
  Loading,
  PageHeader,
  SelectField,
  TextArea,
  WarningMessage,
  buttonLinkClass,
  secondaryButtonLinkClass,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { refusalText } from '../refusals';
import { BlockedBadge } from '../tickets/board';
import { useTicketNumber } from '../tickets/params';
import {
  blockedExplanation,
  markDoneWarning,
  assigneeLabel,
  priorityLabel,
  showsBlocked,
  statusChangeText,
  statusLabel,
  ticketPath,
  ticketRef,
  typeLabel,
} from '../tickets/text';
import { ticketsChanged, useRun, useTicket, useTicketRuns, useTickets } from '../queries';
import { AnswerBox, CommitList, RunActions, RunTimes } from '../runs/components';
import { isActive, purposeLabel, runStateText, runPath, usageText } from '../runs/text';
import { WithProject } from './project';

function ticketApi(ticket: TicketDetail, action = ''): string {
  return `/api/projects/${encodeURIComponent(ticket.projectKey)}/tickets/${String(ticket.number)}${action}`;
}

/** Tickets change only on an active project whose setup is done (04, section 2). */
function canChange(project: Project): boolean {
  return project.status === 'active' && project.setup.status === 'ready';
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-semibold text-slate-900">{children}</h2>;
}

/** A ticket action; the page is read again after it, or after a refusal of it. */
function useTicketAction<T>(request: (input: T) => Promise<TicketDetail>) {
  return useMutation({
    mutationFn: request,
    onSuccess: (changed) => ticketsChanged(changed),
    onError: () => ticketsChanged(),
  });
}

/** **Cancel**, after a confirmation saying what happens (02, section 1). */
function CancelAction({ ticket }: { ticket: TicketDetail }) {
  const [asking, setAsking] = useState(false);
  const cancel = useTicketAction(() => api('POST', ticketApi(ticket, '/cancel'), TicketDetail));
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          cancel.reset();
          setAsking(true);
        }}
      >
        Cancel the ticket
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Cancel ${ref}?`}
          confirmLabel="Cancel the ticket"
          dismissLabel="Keep it"
          busy={cancel.isPending}
          error={cancel.error && <ErrorMessage>{refusalText(cancel.error)}</ErrorMessage>}
          onConfirm={() => {
            cancel.mutate(undefined, {
              onSuccess: () => {
                setAsking(false);
              },
            });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            The ticket is kept with its history, and no work will be done on it. You can reopen it
            later.
          </p>
          {ticket.blocks.length > 0 && (
            <p>
              Tickets waiting for it stay blocked: remove their dependency on {ref}, or reopen it.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/** **Mark as done manually**: the comment explaining why is mandatory (04, section 2). */
function MarkDoneAction({ ticket }: { ticket: TicketDetail }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  const markDone = useTicketAction((body: MarkDoneRequest) =>
    api('POST', ticketApi(ticket, '/mark-done'), TicketDetail, body),
  );
  const ref = ticketRef(ticket.projectKey, ticket.number);
  const warning = markDoneWarning(ticket.projectKey, ticket.number, ticket.blockedBy);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          markDone.reset();
          setMissing(false);
          setAsking(true);
        }}
      >
        Mark as done manually
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Mark ${ref} as done?`}
          confirmLabel={warning ? 'Mark as done anyway' : 'Mark as done'}
          busy={markDone.isPending}
          error={markDone.error && <ErrorMessage>{refusalText(markDone.error)}</ErrorMessage>}
          onConfirm={() => {
            if (comment.trim() === '') {
              setMissing(true);
              return;
            }
            markDone.mutate(
              { comment: comment.trim() },
              {
                onSuccess: () => {
                  setAsking(false);
                  setComment('');
                },
              },
            );
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            Use this when the result exists because the work was done another way. The ticket goes
            to Done, and tickets waiting for it are no longer blocked by it. If the work is
            abandoned, cancel the ticket instead.
          </p>
          {warning && <WarningMessage>{warning}</WarningMessage>}
          <TextArea
            label="Why is it done? (required)"
            hint="Added to the ticket's timeline."
            value={comment}
            error={missing ? 'Write why the ticket is done: this comment is required.' : undefined}
            onChange={(event) => {
              setComment(event.target.value);
              setMissing(false);
            }}
          />
        </ConfirmDialog>
      )}
    </>
  );
}

function ReopenAction({ ticket }: { ticket: TicketDetail }) {
  const reopen = useTicketAction(() => api('POST', ticketApi(ticket, '/reopen'), TicketDetail));
  return (
    <>
      <Button
        onClick={() => {
          reopen.mutate();
        }}
        disabled={reopen.isPending}
      >
        Reopen
      </Button>
      {reopen.error && <ErrorMessage>{refusalText(reopen.error)}</ErrorMessage>}
    </>
  );
}

/**
 * **Run now** (07, section 3): the run starts at once on a machine chosen for it, and the run
 * page opens; when it cannot start, the reason is shown (02, section 6.4).
 */
function RunNowAction({ ticket }: { ticket: TicketDetail }) {
  const navigate = useNavigate();
  const runNow = useMutation({
    mutationFn: () => api('POST', ticketApi(ticket, '/run'), Run),
    onSettled: () => ticketsChanged(),
    onSuccess: (run) => navigate(runPath(run.id)),
  });
  return (
    <>
      <Button
        onClick={() => {
          runNow.mutate();
        }}
        disabled={runNow.isPending}
      >
        Run now
      </Button>
      {runNow.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(runNow.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/** **Accept** a ticket an agent proposed: it goes to To do (04, section 2). */
function AcceptAction({ ticket }: { ticket: TicketDetail }) {
  const accept = useTicketAction(() => api('POST', ticketApi(ticket, '/accept'), TicketDetail));
  return (
    <>
      <Button
        onClick={() => {
          accept.mutate();
        }}
        disabled={accept.isPending}
      >
        Accept
      </Button>
      {accept.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(accept.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/** **Reject** a ticket an agent proposed, with an optional comment: it is cancelled. */
function RejectAction({ ticket }: { ticket: TicketDetail }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const reject = useTicketAction((body: RejectRequest) =>
    api('POST', ticketApi(ticket, '/reject'), TicketDetail, body),
  );
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          reject.reset();
          setAsking(true);
        }}
      >
        Reject
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Reject ${ref}?`}
          confirmLabel="Reject"
          dismissLabel="Keep it"
          busy={reject.isPending}
          error={reject.error && <ErrorMessage>{refusalText(reject.error)}</ErrorMessage>}
          onConfirm={() => {
            reject.mutate(comment.trim() === '' ? {} : { comment: comment.trim() }, {
              onSuccess: () => {
                setAsking(false);
                setComment('');
              },
            });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>The ticket is cancelled and kept with its history. You can reopen it later.</p>
          <TextArea
            label="Why? (optional)"
            hint="Added to the ticket's timeline."
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        </ConfirmDialog>
      )}
    </>
  );
}

/** The actions of the ticket's state (02, section 6.4; 04, section 2). */
function Actions({ project, ticket }: { project: Project; ticket: TicketDetail }) {
  if (!canChange(project)) return null;
  const allowed = (action: OwnerTicketAction) =>
    OWNER_TRANSITIONS[action].from.includes(ticket.status);
  const editable = EDITABLE_STATUSES.includes(ticket.status);
  const proposedByAgent = ticket.status === 'proposed' && ticket.createdByAgent !== null;
  const runnable = ticket.status === 'todo';
  if (!editable && !runnable && !allowed('cancel') && !allowed('mark_done') && !allowed('reopen')) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      {runnable && <RunNowAction ticket={ticket} />}
      {proposedByAgent && <AcceptAction ticket={ticket} />}
      {proposedByAgent && <RejectAction ticket={ticket} />}
      {editable && (
        <Link
          to={`${ticketPath(ticket.projectKey, ticket.number)}/edit`}
          className={runnable || proposedByAgent ? secondaryButtonLinkClass : buttonLinkClass}
        >
          Edit
        </Link>
      )}
      {allowed('reopen') && <ReopenAction ticket={ticket} />}
      {allowed('mark_done') && <MarkDoneAction ticket={ticket} />}
      {allowed('cancel') && !proposedByAgent && <CancelAction ticket={ticket} />}
    </div>
  );
}

/** The ticket's active run: its state, progress line, **Stop run** and **Resume**. */
function ActiveRun({ ticket }: { ticket: TicketDetail }) {
  const run = useRun(ticket.activeRun?.id ?? '', ticket.activeRun !== null);
  if (!ticket.activeRun || !run.data) return null;
  return (
    <Card className="space-y-3">
      <SectionTitle>Run in progress</SectionTitle>
      <p className="font-medium text-slate-900">
        {runStateText(run.data)} · attempt {run.data.attempt} on {run.data.machine.name}
      </p>
      {run.data.progress && (
        <p className="break-words" aria-label="Progress">
          {run.data.progress.text}
        </p>
      )}
      <p className="text-sm text-slate-700">
        <RunTimes run={run.data} />
      </p>
      <Link to={runPath(run.data.id)} className="inline-block text-blue-700 underline">
        Watch the run live
      </Link>
      <RunActions run={run.data} />
    </Card>
  );
}

/**
 * The ticket branch: until pushing exists (lot 3), it lives only on the machine of the last run
 * that reported it (02, section 6.4).
 */
function Branch({ ticket }: { ticket: TicketDetail }) {
  const { branch } = ticket;
  if (!branch) return null;
  return (
    <Card className="space-y-2">
      <SectionTitle>Branch</SectionTitle>
      <p className="break-words" aria-label="Branch">
        <code className="rounded bg-slate-100 px-1 text-sm">{branch.name}</code>
        {branch.machine
          ? ` on machine ${branch.machine.name}, not on GitHub yet`
          : ': no commits reported yet'}
      </p>
      {branch.machine && <CommitList commits={branch.commits} />}
      <p className="text-sm text-slate-600">
        <HelpLink page="runs#where-the-work-is">Where the work is</HelpLink>
      </p>
    </Card>
  );
}

/** The agent's report with its latest accepted submission (lot 2: summary and criteria). */
function Report({ ticket }: { ticket: TicketDetail }) {
  const report = ticket.dodReport;
  if (!report) return null;
  return (
    <Card className="space-y-3">
      <SectionTitle>Agent's report</SectionTitle>
      <UntrustedMarkdown>{report.summary}</UntrustedMarkdown>
      <ol aria-label="Criteria in the report" className="space-y-2">
        {report.criteria.map((criterion) => (
          <li key={criterion.index} className="space-y-1">
            <p className="font-medium text-slate-900">
              {criterion.status === 'met' ? 'Met' : 'Not met'}:{' '}
              {ticket.acceptanceCriteria[criterion.index] ??
                `criterion ${String(criterion.index + 1)}`}
            </p>
            <p className="break-words text-slate-700">{criterion.justification}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Runs of the ticket, newest first (02, section 6.4). */
function Runs({ ticket }: { ticket: TicketDetail }) {
  const runs = useTicketRuns(ticket.projectKey, ticket.number);
  if (!runs.data || runs.data.runs.length === 0) return null;
  return (
    <Card className="space-y-3">
      <SectionTitle>Runs</SectionTitle>
      <p className="text-slate-700">Failed attempts: {ticket.attemptCount}</p>
      <ul aria-label="Runs" className="divide-y divide-slate-200">
        {runs.data.runs.map((run) => (
          <li key={run.id} className="space-y-1 py-2">
            <Link to={runPath(run.id)} className="font-medium text-blue-700 underline">
              Attempt {run.attempt} · {purposeLabel[run.purpose]}
            </Link>
            <p className="text-slate-800">{runStateText(run)}</p>
            <p className="text-sm text-slate-600">
              {run.profile.name} on {run.machine.name} · {formatDateTime(run.createdAt)} ·{' '}
              <RunTimes run={run} /> · {usageText(run.estimatedUsageUsd)}
            </p>
            {run.outcome && !isActive(run.status) && (
              <p className="text-sm break-words text-slate-700">{run.outcome}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BlockedNotice({ ticket }: { ticket: TicketDetail }) {
  if (!showsBlocked(ticket)) return null;
  const { waitingFor, cancelled } = blockedExplanation(ticket.projectKey, ticket.blockedBy);
  return (
    <InfoMessage>
      <div className="space-y-1">
        <p>
          <strong>Blocked.</strong> {waitingFor}
        </p>
        {cancelled && <p className="font-medium">{cancelled}</p>}
        <p>
          <HelpLink page="tickets#blocked-tickets">What “blocked” means</HelpLink>
        </p>
      </div>
    </InfoMessage>
  );
}

function LinkList({
  label,
  ticket,
  links,
  onRemove,
  busy,
}: {
  label: string;
  ticket: TicketDetail;
  links: TicketLink[];
  onRemove?: (link: TicketLink) => void;
  busy?: boolean;
}) {
  if (links.length === 0) return <p className="text-slate-700">None.</p>;
  return (
    <ul aria-label={label} className="space-y-2">
      {links.map((link) => (
        <li key={link.number} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words">
            <Link
              to={ticketPath(ticket.projectKey, link.number)}
              className="text-blue-700 underline"
            >
              {ticketRef(ticket.projectKey, link.number)} · {link.title}
            </Link>{' '}
            <span className="text-slate-600">({statusLabel[link.status]})</span>
          </span>
          {onRemove && (
            <Button
              variant="secondary"
              className="px-3 py-1 text-sm"
              disabled={busy}
              aria-label={`Remove the dependency on ${ticketRef(ticket.projectKey, link.number)}`}
              onClick={() => {
                onRemove(link);
              }}
            >
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Blocked by" and "Blocks", with the dependency editor while the ticket is proposed or todo
 * (02, section 6.4). The blocking ticket can be in any state.
 */
function Dependencies({ project, ticket }: { project: Project; ticket: TicketDetail }) {
  const editable = canChange(project) && EDITABLE_STATUSES.includes(ticket.status);
  const others = useTickets(ticket.projectKey, editable);
  const [choice, setChoice] = useState('');
  const add = useTicketAction((body: AddDependencyRequest) =>
    api('POST', ticketApi(ticket, '/dependencies'), TicketDetail, body),
  );
  const remove = useTicketAction((number: number) =>
    api('DELETE', ticketApi(ticket, `/dependencies/${String(number)}`), TicketDetail),
  );
  const candidates = (others.data?.tickets ?? []).filter(
    (other) =>
      other.number !== ticket.number &&
      !ticket.blockedBy.some((link) => link.number === other.number),
  );
  const error = add.error ?? remove.error;

  return (
    <Card className="space-y-4">
      <SectionTitle>Dependencies</SectionTitle>
      <div className="space-y-2">
        <h3 className="font-medium text-slate-900">Blocked by: tickets it waits for</h3>
        <LinkList
          label="Blocked by"
          ticket={ticket}
          links={ticket.blockedBy}
          busy={remove.isPending}
          {...(editable
            ? {
                onRemove: (link: TicketLink) => {
                  add.reset();
                  remove.mutate(link.number);
                },
              }
            : {})}
        />
      </div>
      {editable ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            if (choice === '') return;
            remove.reset();
            add.mutate(
              { blockedBy: Number(choice) },
              {
                onSuccess: () => {
                  setChoice('');
                },
              },
            );
          }}
        >
          <div className="w-full min-w-0 sm:w-96">
            <SelectField
              label="Add a ticket it waits for"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
                add.reset();
              }}
            >
              <option value="">Choose a ticket</option>
              {candidates.map((other) => (
                <option key={other.number} value={other.number}>
                  {ticketRef(other.projectKey, other.number)} · {other.title} (
                  {statusLabel[other.status]})
                </option>
              ))}
            </SelectField>
          </div>
          <Button type="submit" variant="secondary" disabled={choice === '' || add.isPending}>
            Add
          </Button>
        </form>
      ) : (
        <p className="text-sm text-slate-600">
          Dependencies can be changed only while the ticket is Proposed or To do.
        </p>
      )}
      {error && <ErrorMessage>{refusalText(error)}</ErrorMessage>}
      <div className="space-y-2">
        <h3 className="font-medium text-slate-900">Blocks: tickets waiting for it</h3>
        <LinkList label="Blocks" ticket={ticket} links={ticket.blocks} />
      </div>
    </Card>
  );
}

function TimelineItem({
  entry,
  comments,
}: {
  entry: TimelineEntry;
  comments: Map<string, TimelineEntry>;
}) {
  if (entry.type === 'status_change') {
    const reason = entry.commentId ? comments.get(entry.commentId) : undefined;
    return (
      <li className="space-y-1 border-l-4 border-slate-300 pl-3">
        <p className="text-sm text-slate-600">{formatDateTime(entry.at)}</p>
        <p className="font-medium text-slate-900">{statusChangeText(entry)}</p>
        {reason?.type === 'comment' && <UntrustedMarkdown>{reason.comment.body}</UntrustedMarkdown>}
      </li>
    );
  }
  const { comment } = entry;
  return (
    <li className="space-y-1 border-l-4 border-blue-200 pl-3">
      <p className="text-sm text-slate-600">
        {comment.author === 'owner'
          ? 'You'
          : comment.agent
            ? `Agent ${comment.agent.profile.name}`
            : 'The Orchestrator'}{' '}
        · {formatDateTime(entry.at)}
      </p>
      <UntrustedMarkdown>{comment.body}</UntrustedMarkdown>
    </li>
  );
}

/** Comments and status changes, oldest first; a status change shows its comment. */
function Timeline({ project, ticket }: { project: Project; ticket: TicketDetail }) {
  const [body, setBody] = useState('');
  const [missing, setMissing] = useState(false);
  const addComment = useTicketAction((input: AddCommentRequest) =>
    api('POST', ticketApi(ticket, '/comments'), TicketDetail, input),
  );
  const comments = new Map(
    ticket.timeline.flatMap((entry) =>
      entry.type === 'comment' ? [[entry.comment.id, entry] as const] : [],
    ),
  );
  const attached = new Set(
    ticket.timeline.flatMap((entry) =>
      entry.type === 'status_change' && entry.commentId ? [entry.commentId] : [],
    ),
  );
  const entries = ticket.timeline.filter(
    (entry) => entry.type !== 'comment' || !attached.has(entry.comment.id),
  );

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (body.trim() === '') {
      setMissing(true);
      return;
    }
    addComment.mutate(
      { body: body.trim() },
      {
        onSuccess: () => {
          setBody('');
        },
      },
    );
  }

  return (
    <Card className="space-y-4">
      <SectionTitle>Timeline</SectionTitle>
      {entries.length === 0 ? (
        <p className="text-slate-700">No comments or status changes yet.</p>
      ) : (
        <ol aria-label="Timeline" className="space-y-4">
          {entries.map((entry, index) => (
            <TimelineItem key={index} entry={entry} comments={comments} />
          ))}
        </ol>
      )}
      {canChange(project) && (
        <form className="space-y-2" onSubmit={submit} noValidate>
          <TextArea
            label="Add a comment"
            hint="Markdown is allowed. Links open in a new tab; images are shown as links."
            rows={4}
            value={body}
            error={missing ? 'Write a comment first.' : undefined}
            onChange={(event) => {
              setBody(event.target.value);
              setMissing(false);
              addComment.reset();
            }}
          />
          {addComment.error && <ErrorMessage>{refusalText(addComment.error)}</ErrorMessage>}
          <Button type="submit" disabled={addComment.isPending}>
            Add comment
          </Button>
        </form>
      )}
    </Card>
  );
}

function TicketContent({ project, number }: { project: Project; number: number }) {
  const ticket = useTicket(project.key, number);
  if (ticket.isPending) return <Loading />;
  if (ticket.isError) {
    const missing =
      ticket.error instanceof ApiRequestError && ticket.error.code === 'ticket_not_found';
    return (
      <div className="space-y-3">
        <ErrorMessage>
          {missing
            ? 'This ticket does not exist in this project.'
            : 'The ticket could not be loaded. Reload the page.'}
        </ErrorMessage>
        <Link to={`/projects/${project.key}`} className="text-blue-700 underline">
          Back to {project.key} · {project.name}
        </Link>
      </div>
    );
  }
  const data = ticket.data;
  return (
    <>
      <PageHeader
        title={`${ticketRef(data.projectKey, data.number)} · ${data.title}`}
        help="tickets"
      />
      <div className="space-y-4">
        <Link to={`/projects/${project.key}`} className="inline-block text-blue-700 underline">
          Back to {project.key} · {project.name}
        </Link>
        {project.status === 'archived' && (
          <InfoMessage>
            <p>This project is archived: its tickets are read-only. Unarchive it to change them.</p>
          </InfoMessage>
        )}
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-slate-800 px-2 py-0.5 text-sm text-white">
              {statusLabel[data.status]}
            </span>
            {showsBlocked(data) && <BlockedBadge />}
          </div>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="text-slate-600">Type</dt>
            <dd>{typeLabel[data.type]}</dd>
            <dt className="text-slate-600">Priority</dt>
            <dd>{priorityLabel[data.priority]}</dd>
            <dt className="text-slate-600">Assignee</dt>
            <dd>{assigneeLabel(data.assignee)}</dd>
            <dt className="text-slate-600">Created</dt>
            <dd>
              {formatDateTime(data.createdAt)}{' '}
              {data.createdByAgent ? `by agent ${data.createdByAgent.profile.name}` : 'by you'}
            </dd>
          </dl>
          <Actions project={project} ticket={data} />
        </Card>
        <AnswerBox ticket={data} />
        <ActiveRun ticket={data} />
        <BlockedNotice ticket={data} />
        <Card className="space-y-4">
          <div className="space-y-2">
            <SectionTitle>Description</SectionTitle>
            {data.description === '' ? (
              <p className="text-slate-700">No description.</p>
            ) : (
              <UntrustedMarkdown>{data.description}</UntrustedMarkdown>
            )}
          </div>
          <div className="space-y-2">
            <SectionTitle>Acceptance criteria</SectionTitle>
            {data.acceptanceCriteria.length === 0 ? (
              <p className="text-slate-700">None.</p>
            ) : (
              <ol aria-label="Acceptance criteria" className="list-decimal space-y-1 pl-6">
                {data.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>
                    <UntrustedMarkdown>{criterion}</UntrustedMarkdown>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>
        <Branch ticket={data} />
        <Report ticket={data} />
        <Dependencies project={project} ticket={data} />
        <Runs ticket={data} />
        <Timeline project={project} ticket={data} />
      </div>
    </>
  );
}

/** Ticket detail (02, section 6.4). */
export function TicketPage() {
  const number = useTicketNumber();
  return (
    <WithProject>
      {(project) =>
        number === null ? (
          <ErrorMessage>This ticket does not exist in this project.</ErrorMessage>
        ) : (
          <TicketContent project={project} number={number} />
        )
      }
    </WithProject>
  );
}
