import {
  CreateTicketRequest,
  type AgentKey,
  EDITABLE_STATUSES,
  TicketDetail,
  TicketPriority,
  TicketType,
  UpdateTicketRequest,
  type Project,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  ErrorMessage,
  Loading,
  PageHeader,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui';
import { refusalText } from '../refusals';
import { priorityLabel, statusLabel, ticketPath, ticketRef, typeLabel } from '../tickets/text';
import { ticketsChanged, useAgents, useTicket, useTickets } from '../queries';
import { WithProject } from './project';
import { useTicketNumber } from '../tickets/params';

interface Fields {
  type: TicketType;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: TicketPriority;
  /** Key of the agent profile expected to do the work, or null. */
  assignee: AgentKey | null;
}

const MARKDOWN_HINT = 'Markdown is allowed. Links open in a new tab; images are shown as links.';

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  if (item !== undefined) copy.splice(to, 0, item);
  return copy;
}

/** The ordered acceptance criteria: add, change, move up or down, remove. */
function CriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: string[];
  onChange: (criteria: string[]) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium text-slate-800">Acceptance criteria</legend>
      <p className="text-sm text-slate-600">
        Statements that must be true when the ticket is done, in order. Empty ones are left out.
      </p>
      {criteria.length > 0 && (
        <ol className="space-y-3">
          {criteria.map((criterion, index) => {
            const number = String(index + 1);
            return (
              <li key={index} className="space-y-2 rounded border border-slate-200 p-3">
                <TextArea
                  label={`Acceptance criterion ${number}`}
                  rows={2}
                  value={criterion}
                  onChange={(event) => {
                    onChange(criteria.map((each, i) => (i === index ? event.target.value : each)));
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    disabled={index === 0}
                    aria-label={`Move criterion ${number} up`}
                    onClick={() => {
                      onChange(move(criteria, index, index - 1));
                    }}
                  >
                    Move up
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    disabled={index === criteria.length - 1}
                    aria-label={`Move criterion ${number} down`}
                    onClick={() => {
                      onChange(move(criteria, index, index + 1));
                    }}
                  >
                    Move down
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    aria-label={`Remove criterion ${number}`}
                    onClick={() => {
                      onChange(criteria.filter((_, i) => i !== index));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          onChange([...criteria, '']);
        }}
      >
        Add a criterion
      </Button>
    </fieldset>
  );
}

/** The agent expected to do the work: any profile until lot 6 (01, section 3.4). */
function AssigneeField({
  value,
  onChange,
}: {
  value: AgentKey | null;
  onChange: (assignee: AgentKey | null) => void;
}) {
  const agents = useAgents();
  // Only agents that implement: Quality reviews and is never assigned (03, section 4).
  const listed = (agents.data?.agents ?? []).filter(
    (agent) => agent.role === 'builder' || agent.role === 'writer',
  );
  return (
    <SelectField
      label="Assignee"
      hint={
        <>
          The agent expected to do the work.{' '}
          <Link to="/help/agents" className="text-blue-700 underline">
            About agents
          </Link>
        </>
      }
      value={value ?? ''}
      disabled={agents.isPending}
      onChange={(event) => {
        onChange(event.target.value === '' ? null : event.target.value);
      }}
    >
      <option value="">No assignee</option>
      {listed.map((agent) => (
        <option key={agent.key} value={agent.key}>
          {agent.name}
        </option>
      ))}
      {value !== null && !listed.some((agent) => agent.key === value) && (
        <option value={value}>{value}</option>
      )}
    </SelectField>
  );
}

/** Dependencies of a new ticket: tickets of the project it waits for, in any state. */
function NewDependencies({
  project,
  chosen,
  onChange,
}: {
  project: Project;
  chosen: number[];
  onChange: (numbers: number[]) => void;
}) {
  const tickets = useTickets(project.key);
  const all = tickets.data?.tickets ?? [];
  if (all.length === 0) return null;
  const title = (number: number) => all.find((each) => each.number === number)?.title ?? '';
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium text-slate-800">Blocked by</legend>
      <p className="text-sm text-slate-600">
        Tickets that must be done before work on this one can start.
      </p>
      {chosen.length > 0 && (
        <ul aria-label="Blocked by" className="space-y-2">
          {chosen.map((number) => (
            <li key={number} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">
                {ticketRef(project.key, number)} · {title(number)}
              </span>
              <Button
                variant="secondary"
                className="px-3 py-1 text-sm"
                aria-label={`Remove ${ticketRef(project.key, number)}`}
                onClick={() => {
                  onChange(chosen.filter((each) => each !== number));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <SelectField
        label="Add a ticket it waits for"
        value=""
        onChange={(event) => {
          if (event.target.value !== '') onChange([...chosen, Number(event.target.value)]);
        }}
      >
        <option value="">Choose a ticket</option>
        {all
          .filter((each) => !chosen.includes(each.number))
          .map((each) => (
            <option key={each.number} value={each.number}>
              {ticketRef(project.key, each.number)} · {each.title} ({statusLabel[each.status]})
            </option>
          ))}
      </SelectField>
    </fieldset>
  );
}

/**
 * Create and edit form (02, section 6.4). Dependencies are chosen here for a new ticket; an
 * existing ticket's dependencies are changed on its page.
 */
function TicketForm({
  project,
  initial,
  submitLabel,
  cancelTo,
  withDependencies = false,
  onSubmit,
}: {
  project: Project;
  initial: Fields;
  submitLabel: string;
  cancelTo: string;
  /** A new ticket's dependencies are chosen in the form. */
  withDependencies?: boolean;
  onSubmit: (fields: Fields, blockedBy: number[]) => Promise<TicketDetail>;
}) {
  const navigate = useNavigate();
  const [fields, setFields] = useState(initial);
  const [blockedBy, setBlockedBy] = useState<number[]>([]);
  const [triedEmpty, setTriedEmpty] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      onSubmit(
        {
          ...fields,
          title: fields.title.trim(),
          description: fields.description.trim(),
          acceptanceCriteria: fields.acceptanceCriteria
            .map((each) => each.trim())
            .filter((each) => each !== ''),
        },
        blockedBy,
      ),
    onSuccess: async (ticket) => {
      await ticketsChanged(ticket);
      await navigate(ticketPath(ticket.projectKey, ticket.number));
    },
  });
  const titleError = triedEmpty && fields.title.trim() === '' ? 'Enter a title.' : null;
  const change = (next: Partial<Fields>) => {
    setFields({ ...fields, ...next });
    save.reset();
  };

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (fields.title.trim() === '') {
      setTriedEmpty(true);
      return;
    }
    save.mutate();
  }

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <SelectField
        label="Type"
        value={fields.type}
        onChange={(event) => {
          change({ type: event.target.value as TicketType });
        }}
      >
        {TicketType.options.map((each) => (
          <option key={each} value={each}>
            {typeLabel[each]}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Title"
        value={fields.title}
        error={titleError}
        onChange={(event) => {
          change({ title: event.target.value });
        }}
      />
      <TextArea
        label="Description"
        hint={`What must be done and why. ${MARKDOWN_HINT}`}
        rows={6}
        value={fields.description}
        onChange={(event) => {
          change({ description: event.target.value });
        }}
      />
      <CriteriaEditor
        criteria={fields.acceptanceCriteria}
        onChange={(acceptanceCriteria) => {
          change({ acceptanceCriteria });
        }}
      />
      <SelectField
        label="Priority"
        value={fields.priority}
        onChange={(event) => {
          change({ priority: event.target.value as TicketPriority });
        }}
      >
        {TicketPriority.options.map((each) => (
          <option key={each} value={each}>
            {priorityLabel[each]}
          </option>
        ))}
      </SelectField>
      <AssigneeField
        value={fields.assignee}
        onChange={(assignee) => {
          change({ assignee });
        }}
      />
      {withDependencies && (
        <NewDependencies project={project} chosen={blockedBy} onChange={setBlockedBy} />
      )}
      {save.error && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {submitLabel}
        </Button>
        <Link to={cancelTo} className="text-blue-700 underline">
          Back without saving
        </Link>
      </div>
    </form>
  );
}

function ticketsApi(project: Project, path = ''): string {
  return `/api/projects/${encodeURIComponent(project.key)}/tickets${path}`;
}

/** New ticket, created by the owner in To do (04, section 2). */
export function NewTicketPage() {
  return (
    <WithProject>
      {(project) => (
        <>
          <PageHeader title="New ticket" help="tickets#create-a-ticket" />
          <Card>
            {project.status === 'active' && project.setup.status === 'ready' ? (
              <TicketForm
                project={project}
                initial={{
                  type: 'feature',
                  title: '',
                  description: '',
                  acceptanceCriteria: [],
                  priority: 'normal',
                  assignee: null,
                }}
                submitLabel="Create the ticket"
                cancelTo={`/projects/${project.key}`}
                withDependencies
                onSubmit={(fields, blockedBy) =>
                  api(
                    'POST',
                    ticketsApi(project),
                    TicketDetail,
                    CreateTicketRequest.parse({ ...fields, blockedBy }),
                  )
                }
              />
            ) : (
              <p>
                Tickets can be created only on an active project whose repository setup is done.{' '}
                <Link to={`/projects/${project.key}`} className="text-blue-700 underline">
                  Back to {project.key} · {project.name}
                </Link>
              </p>
            )}
          </Card>
        </>
      )}
    </WithProject>
  );
}

function EditForm({ project, number }: { project: Project; number: number }) {
  const ticket = useTicket(project.key, number);
  if (ticket.isPending) return <Loading />;
  if (ticket.isError) {
    const missing =
      ticket.error instanceof ApiRequestError && ticket.error.code === 'ticket_not_found';
    return (
      <ErrorMessage>
        {missing
          ? 'This ticket does not exist in this project.'
          : 'The ticket could not be loaded. Reload the page.'}
      </ErrorMessage>
    );
  }
  const data = ticket.data;
  const back = ticketPath(project.key, number);
  if (
    project.status !== 'active' ||
    project.setup.status !== 'ready' ||
    !EDITABLE_STATUSES.includes(data.status)
  ) {
    return (
      <p>
        {ticketRef(project.key, number)} can be edited only while it is Proposed or To do, on an
        active project. It is {statusLabel[data.status]}.{' '}
        <Link to={back} className="text-blue-700 underline">
          Back to the ticket
        </Link>
      </p>
    );
  }
  return (
    <TicketForm
      project={project}
      initial={{
        type: data.type,
        title: data.title,
        description: data.description,
        acceptanceCriteria: data.acceptanceCriteria,
        priority: data.priority,
        assignee: data.assignee?.key ?? null,
      }}
      submitLabel="Save"
      cancelTo={back}
      onSubmit={(fields) =>
        api(
          'PATCH',
          ticketsApi(project, `/${String(number)}`),
          TicketDetail,
          UpdateTicketRequest.parse(fields),
        )
      }
    />
  );
}

/** Edit a ticket, only in Proposed or To do (02, section 6.4). */
export function EditTicketPage() {
  const number = useTicketNumber();
  return (
    <WithProject>
      {(project) => (
        <>
          <PageHeader
            title={number === null ? 'Edit' : `Edit ${ticketRef(project.key, number)}`}
            help="tickets#edit-a-ticket"
          />
          <Card>
            {number === null ? (
              <ErrorMessage>This ticket does not exist in this project.</ErrorMessage>
            ) : (
              <EditForm project={project} number={number} />
            )}
          </Card>
        </>
      )}
    </WithProject>
  );
}
