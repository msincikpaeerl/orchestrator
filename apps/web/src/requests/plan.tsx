import {
  ApprovePlanRequest,
  PlanActionRequest,
  ProjectKey,
  RejectPlanRequest,
  RepositoryName,
  slugify,
  type PlanNewProject,
  RequestDetail,
  TicketPriority,
  TicketType,
  UpdatePlanTicketRequest,
  type AgentKey,
  type PlanBlocker,
  type PlanTicketView,
  type PlanView,
  type TicketImportProblem,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../api';
import { DependencyGraph, type GraphItem } from '../components/dependency-graph';
import { UntrustedMarkdown } from '../components/markdown';
import {
  Button,
  Card,
  ConfirmDialog,
  ErrorMessage,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import {
  projectsChanged,
  requestsChanged,
  useGitHubStatus,
  useProject,
  useTickets,
} from '../queries';
import {
  KeyField,
  KindHint,
  RepositoryNameField,
  VisibilityField,
  keyError,
  repositoryNameError,
  useAvailability,
} from '../projects/new-project-fields';
import {
  kindLabel,
  refusalText as projectRefusal,
  suggestKey,
  type ErrorField,
} from '../projects/text';
import { refusalText } from '../refusals';
import { AssigneeField, CriteriaEditor } from '../tickets/fields';
import { priorityLabel, statusLabel, ticketPath, ticketRef, typeLabel } from '../tickets/text';
import {
  approveNewProjectText,
  approveText,
  blockerText,
  blockerValue,
  earlierPlanHeading,
  notApprovableText,
  planProblemPlace,
  removeTexts,
} from './plan-text';

// The request page's plan (02, section 5.3; lot 5 step F2): the plan's tickets, their edits and
// removal, Approve and Reject with feedback, and the earlier plans.

const MARKDOWN_HINT = 'Markdown is allowed. Links open in a new tab; images are shown as links.';

function planApi(request: RequestDetail, path: string): string {
  return `/api/requests/${String(request.number)}/plan${path}`;
}

/** A refusal, with the plan's problems listed when it has them (owner's answers 5 and 9). */
function Refusal({ error }: { error: Error }) {
  const problems: TicketImportProblem[] =
    error instanceof ApiRequestError ? (error.planProblems ?? []) : [];
  if (problems.length === 0) return <ErrorMessage>{refusalText(error)}</ErrorMessage>;
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      <p>{refusalText(error)}</p>
      <ul aria-label="Problems" className="mt-1 list-disc space-y-1 pl-5">
        {problems.map((problem, index) => (
          <li key={index} className="break-words">
            <strong>{planProblemPlace(problem)}</strong>: {problem.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-medium text-slate-900">{children}</h3>;
}

interface Fields {
  type: TicketType;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: TicketPriority;
  assignee: AgentKey | null;
  blockedBy: string[];
}

function fieldsOf(ticket: PlanTicketView): Fields {
  return {
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptance_criteria,
    priority: ticket.priority,
    assignee: ticket.assignee,
    blockedBy: ticket.waitsFor.map(blockerValue),
  };
}

/** Only the fields the owner changed; the bootstrap's fixed ones never sent (answer 6). */
function changes(ticket: PlanTicketView, fields: Fields): Partial<UpdatePlanTicketRequest> {
  const before = fieldsOf(ticket);
  const after: Fields = {
    ...fields,
    title: fields.title.trim(),
    description: fields.description.trim(),
    acceptanceCriteria: fields.acceptanceCriteria
      .map((each) => each.trim())
      .filter((each) => each !== ''),
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changed: Partial<UpdatePlanTicketRequest> = {};
  if (after.title !== before.title) changed.title = after.title;
  if (after.description !== before.description) changed.description = after.description;
  if (!same(after.acceptanceCriteria, before.acceptanceCriteria)) {
    changed.acceptanceCriteria = after.acceptanceCriteria;
  }
  if (after.priority !== before.priority) changed.priority = after.priority;
  if (!ticket.bootstrap) {
    if (after.type !== before.type) changed.type = after.type;
    if (after.assignee !== before.assignee) changed.assignee = after.assignee;
    if (!same(after.blockedBy, before.blockedBy)) changed.blockedBy = after.blockedBy;
  }
  return changed;
}

/** "Waits for": tickets of the plan, and tickets of the project not cancelled (answer 2). */
function WaitsForEditor({
  request,
  plan,
  ticket,
  chosen,
  onChange,
}: {
  request: RequestDetail;
  plan: PlanView;
  ticket: PlanTicketView;
  chosen: string[];
  onChange: (chosen: string[]) => void;
}) {
  const projectKey = request.project?.key ?? '';
  const tickets = useTickets(projectKey, request.project !== null);
  const existing = (tickets.data?.tickets ?? []).filter((each) => each.status !== 'cancelled');
  const label = (value: string): string => {
    const inPlan = plan.tickets.find((each) => each.key === value);
    if (inPlan) return `${inPlan.key} · ${inPlan.title}`;
    const found = existing.find((each) => ticketRef(projectKey, each.number) === value);
    if (found) return `${value} · ${found.title}`;
    const shown = ticket.waitsFor.find((each) => blockerValue(each) === value);
    return shown ? blockerText(shown) : value;
  };
  const planChoices = plan.tickets.filter(
    (each) => each.key !== ticket.key && !chosen.includes(each.key),
  );
  const projectChoices = existing.filter(
    (each) => !chosen.includes(ticketRef(projectKey, each.number)),
  );
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium text-slate-800">Waits for</legend>
      <p className="text-sm text-slate-600">
        Tickets that must be done before work on this one can start.
      </p>
      {chosen.length > 0 && (
        <ul aria-label="Waits for" className="space-y-2">
          {chosen.map((value) => (
            <li key={value} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{label(value)}</span>
              <Button
                variant="secondary"
                className="px-3 py-1 text-sm"
                aria-label={`Remove ${value} from what it waits for`}
                onClick={() => {
                  onChange(chosen.filter((each) => each !== value));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(planChoices.length > 0 || projectChoices.length > 0) && (
        <SelectField
          label="Add a ticket it waits for"
          value=""
          onChange={(event) => {
            if (event.target.value !== '') onChange([...chosen, event.target.value]);
          }}
        >
          <option value="">Choose a ticket</option>
          {planChoices.length > 0 && (
            <optgroup label="In this plan">
              {planChoices.map((each) => (
                <option key={each.key} value={each.key}>
                  {each.key} · {each.title}
                </option>
              ))}
            </optgroup>
          )}
          {projectChoices.length > 0 && (
            <optgroup label={`In ${projectKey}`}>
              {projectChoices.map((each) => (
                <option key={each.number} value={ticketRef(projectKey, each.number)}>
                  {ticketRef(projectKey, each.number)} · {each.title} ({statusLabel[each.status]})
                </option>
              ))}
            </optgroup>
          )}
        </SelectField>
      )}
    </fieldset>
  );
}

/** The edit form, in the ticket's card (owner's answer 2, step F2). */
function PlanTicketForm({
  request,
  plan,
  ticket,
  onDone,
}: {
  request: RequestDetail;
  plan: PlanView;
  ticket: PlanTicketView;
  onDone: () => void;
}) {
  const [fields, setFields] = useState(() => fieldsOf(ticket));
  const [triedEmpty, setTriedEmpty] = useState(false);
  const save = useMutation({
    mutationFn: (changed: Partial<UpdatePlanTicketRequest>) =>
      api(
        'PATCH',
        planApi(request, `/tickets/${encodeURIComponent(ticket.key)}`),
        RequestDetail,
        UpdatePlanTicketRequest.parse({ planId: plan.id, ...changed }),
      ),
    onSuccess: async (detail) => {
      await requestsChanged(detail);
      onDone();
    },
  });
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
    const changed = changes(ticket, fields);
    if (Object.keys(changed).length === 0) {
      onDone();
      return;
    }
    save.mutate(changed);
  }

  return (
    <form className="space-y-5" aria-label={`Edit ${ticket.key}`} onSubmit={submit} noValidate>
      {ticket.bootstrap ? (
        <div className="space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-slate-700">
          <p>
            Type: {typeLabel[ticket.type]} · Assignee: {ticket.assigneeName ?? 'No assignee'} ·
            Waits for:{' '}
            {ticket.waitsFor.length === 0 ? 'nothing' : ticket.waitsFor.map(blockerText).join(', ')}
          </p>
          <p>Fixed: every other ticket waits for this one.</p>
        </div>
      ) : (
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
      )}
      <TextField
        label="Title"
        value={fields.title}
        error={triedEmpty && fields.title.trim() === '' ? 'Enter a title.' : null}
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
      {!ticket.bootstrap && (
        <>
          <AssigneeField
            value={fields.assignee}
            onChange={(assignee) => {
              change({ assignee });
            }}
          />
          <WaitsForEditor
            request={request}
            plan={plan}
            ticket={ticket}
            chosen={fields.blockedBy}
            onChange={(blockedBy) => {
              change({ blockedBy });
            }}
          />
        </>
      )}
      {save.error && <Refusal error={save.error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** **Remove**'s confirmation (owner's answer 4, step F2). */
function RemoveDialog({
  request,
  plan,
  ticket,
  onClose,
}: {
  request: RequestDetail;
  plan: PlanView;
  ticket: PlanTicketView;
  onClose: () => void;
}) {
  const remove = useMutation({
    mutationFn: () =>
      api(
        'POST',
        planApi(request, `/tickets/${encodeURIComponent(ticket.key)}/remove`),
        RequestDetail,
        PlanActionRequest.parse({ planId: plan.id }),
      ),
    onSuccess: async (detail) => {
      await requestsChanged(detail);
      onClose();
    },
  });
  const texts = removeTexts(plan, ticket);
  return (
    <ConfirmDialog
      title={texts.title}
      confirmLabel="Remove"
      dismissLabel="Keep it"
      busy={remove.isPending}
      error={remove.error && <Refusal error={remove.error} />}
      onConfirm={() => {
        remove.mutate();
      }}
      onCancel={onClose}
    >
      {texts.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </ConfirmDialog>
  );
}

function PlanTicketCard({
  request,
  plan,
  ticket,
  editable,
}: {
  request: RequestDetail;
  plan: PlanView;
  ticket: PlanTicketView;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const criteria = ticket.acceptance_criteria;
  return (
    <li
      aria-label={`${ticket.key} · ${ticket.title}`}
      className="min-w-0 space-y-2 rounded border border-slate-200 p-3"
    >
      <p className="font-medium break-words text-slate-900">
        {ticket.key} · {ticket.title}
        {ticket.bootstrap && (
          <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-sm font-normal text-slate-800">
            Bootstrap ticket
          </span>
        )}
      </p>
      {editing ? (
        <PlanTicketForm
          request={request}
          plan={plan}
          ticket={ticket}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="text-sm text-slate-700">
            {typeLabel[ticket.type]} · {priorityLabel[ticket.priority]} priority ·{' '}
            {ticket.assigneeName ?? 'No assignee'}
          </p>
          {ticket.description !== '' && (
            <div className="min-w-0 break-words">
              <UntrustedMarkdown>{ticket.description}</UntrustedMarkdown>
            </div>
          )}
          {criteria.length > 0 && (
            <div className="space-y-1">
              <SubTitle>Acceptance criteria</SubTitle>
              <ol className="list-decimal space-y-1 pl-6 break-words text-slate-800">
                {criteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-sm break-words text-slate-700">
            {ticket.waitsFor.length === 0
              ? 'Waits for nothing.'
              : `Waits for ${ticket.waitsFor.map(blockerText).join(', ')}.`}
          </p>
          {ticket.created && request.project && (
            <p className="text-sm text-slate-700">
              Created as{' '}
              <Link
                to={ticketPath(request.project.key, ticket.created.number)}
                className="text-blue-700 underline"
              >
                {ticket.created.reference}
              </Link>
            </p>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="px-3 py-1 text-sm"
                aria-label={`Edit ${ticket.key}`}
                onClick={() => {
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              {!ticket.bootstrap && (
                <Button
                  variant="secondary"
                  className="px-3 py-1 text-sm"
                  aria-label={`Remove ${ticket.key}`}
                  onClick={() => {
                    setRemoving(true);
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {removing && (
        <RemoveDialog
          request={request}
          plan={plan}
          ticket={ticket}
          onClose={() => {
            setRemoving(false);
          }}
        />
      )}
    </li>
  );
}

/** "WEB-3" → 3; null for a reference the page cannot link. */
function referenceNumber(reference: string): number | null {
  const match = /-(\d+)$/.exec(reference);
  return match ? Number(match[1]) : null;
}

/**
 * The plan's dependency graph (02, section 5.3; owner's answers 7 and 8, lot 5 step H): its
 * tickets by key, and the project's tickets they wait for, as cards in the first column.
 */
function PlanGraph({ request, plan }: { request: RequestDetail; plan: PlanView }) {
  if (plan.tickets.length < 2) return null;
  const projectKey = request.project?.key ?? null;
  const existing = new Map<string, Extract<PlanBlocker, { kind: 'ticket' }>>();
  for (const ticket of plan.tickets) {
    for (const blocker of ticket.waitsFor) {
      if (blocker.kind === 'ticket') existing.set(blocker.reference, blocker);
    }
  }
  const items: GraphItem[] = [
    ...[...existing.values()].map((blocker): GraphItem => {
      const number = referenceNumber(blocker.reference);
      const name = `${blocker.reference} · ${blocker.title ?? 'no such ticket in the project'}`;
      return {
        id: `ticket:${blocker.reference}`,
        name: blocker.reference,
        waitsFor: [],
        label: name,
        content: (
          <>
            {projectKey !== null && number !== null && blocker.title !== null ? (
              <Link
                to={ticketPath(projectKey, number)}
                className="block font-medium break-words text-blue-700 underline"
              >
                {name}
              </Link>
            ) : (
              <p className="font-medium break-words text-slate-900">{name}</p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
              {projectKey !== null && <span>Already in {projectKey}</span>}
              {blocker.status !== null && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
                  {statusLabel[blocker.status]}
                </span>
              )}
            </div>
          </>
        ),
      };
    }),
    ...plan.tickets.map((ticket): GraphItem => ({
      id: `plan:${ticket.key}`,
      name: ticket.key,
      waitsFor: ticket.waitsFor.map((blocker) =>
        blocker.kind === 'plan' ? `plan:${blocker.key}` : `ticket:${blocker.reference}`,
      ),
      label: `${ticket.key} · ${ticket.title}`,
      content: (
        <>
          <p className="font-medium break-words text-slate-900">
            {ticket.key} · {ticket.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
            <span>
              {typeLabel[ticket.type]} · {ticket.assigneeName ?? 'No assignee'}
            </span>
            {ticket.bootstrap && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
                Bootstrap ticket
              </span>
            )}
          </div>
          {ticket.created && projectKey !== null && (
            <p className="mt-1 text-sm text-slate-700">
              Created as{' '}
              <Link
                to={ticketPath(projectKey, ticket.created.number)}
                className="text-blue-700 underline"
              >
                {ticket.created.reference}
              </Link>
            </p>
          )}
        </>
      ),
    })),
  ];
  return (
    <div className="space-y-2">
      <SubTitle>Dependencies</SubTitle>
      <DependencyGraph label="Dependencies" items={items} headingLevel={4} />
    </div>
  );
}

function PlanTickets({
  request,
  plan,
  editable,
}: {
  request: RequestDetail;
  plan: PlanView;
  editable: boolean;
}) {
  return (
    <ol aria-label="Tickets of the plan" className="space-y-3">
      {plan.tickets.map((ticket) => (
        <PlanTicketCard
          key={ticket.key}
          request={request}
          plan={plan}
          ticket={ticket}
          editable={editable}
        />
      ))}
    </ol>
  );
}

function NewProjectDetails({ plan }: { plan: PlanView }) {
  if (plan.newProject === null) return null;
  return (
    <div className="space-y-1 rounded border border-slate-200 bg-slate-50 p-3">
      <SubTitle>New project</SubTitle>
      <p className="break-words text-slate-800">
        {plan.newProject.name} · {kindLabel[plan.newProject.kind]}
      </p>
      {plan.newProject.description !== '' && (
        <p className="break-words text-slate-700">{plan.newProject.description}</p>
      )}
    </div>
  );
}

/** **Approve** and its confirmation (owner's answer 12, step F). */
function ApproveAction({ request, plan }: { request: RequestDetail; plan: PlanView }) {
  const [asking, setAsking] = useState(false);
  const approve = useMutation({
    mutationFn: () =>
      api(
        'POST',
        planApi(request, '/approve'),
        RequestDetail,
        PlanActionRequest.parse({ planId: plan.id }),
      ),
    onSuccess: async (detail) => {
      await requestsChanged(detail);
      setAsking(false);
    },
  });
  return (
    <>
      <Button
        onClick={() => {
          approve.reset();
          setAsking(true);
        }}
      >
        Approve
      </Button>
      {asking && (
        <ConfirmDialog
          title="Approve this plan?"
          confirmLabel="Approve"
          dismissLabel="Keep reviewing"
          busy={approve.isPending}
          error={approve.error && <Refusal error={approve.error} />}
          onConfirm={() => {
            approve.mutate();
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>{approveText(plan.tickets.length, request.project?.key ?? '')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The approval form of a plan creating a project, with **Approve** and its confirmation (owner's
 * answers 2, 6 and 7, step G): the name from the plan, the key suggested from it, the repository
 * name made from it, both checked free as they are typed, and the visibility; the kind and the
 * description are the plan's. A key or a name refused is shown next to its field.
 */
function NewProjectApproval({
  request,
  plan,
  planned,
}: {
  request: RequestDetail;
  plan: PlanView;
  planned: PlanNewProject;
}) {
  const [name, setName] = useState(planned.name);
  const [key, setKey] = useState(suggestKey(planned.name));
  const [keyEdited, setKeyEdited] = useState(false);
  const [repositoryName, setRepositoryName] = useState(slugify(planned.name));
  const [repositoryEdited, setRepositoryEdited] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [refusal, setRefusal] = useState<{ field: ErrorField; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const github = useGitHubStatus();
  const account = github.data?.connected ? github.data.account : null;

  const keyValid = ProjectKey.safeParse(key).success;
  const keyAvailability = useAvailability('key', key, keyValid);
  const repositoryValid = RepositoryName.safeParse(repositoryName).success;
  const repositoryAvailability = useAvailability('repositoryName', repositoryName, repositoryValid);
  const keyErrorText = keyError({
    key,
    availability: keyAvailability,
    refusal: refusal?.field === 'key' ? refusal.text : null,
    submitted,
  });
  const repositoryError = repositoryNameError({
    name: repositoryName,
    availability: repositoryAvailability,
    refusal: refusal?.field === 'repository' ? refusal.text : null,
    submitted,
    linkOffered: false,
  });
  const nameError = submitted && name.trim() === '' ? 'Enter a name.' : null;

  const approve = useMutation({
    mutationFn: () =>
      api(
        'POST',
        planApi(request, '/approve'),
        RequestDetail,
        ApprovePlanRequest.parse({
          planId: plan.id,
          project: { name: name.trim(), key, repositoryName, private: isPrivate },
        }),
      ),
    onSuccess: async (detail) => {
      await Promise.all([requestsChanged(detail), projectsChanged()]);
      setAsking(false);
    },
    onError: (error) => {
      // A key or a repository name taken since: shown next to its field.
      const found = projectRefusal(error);
      if (found.field !== 'form') {
        setRefusal(found);
        setAsking(false);
      }
    },
  });

  function changeName(value: string) {
    setName(value);
    setRefusal(null);
    if (!keyEdited) setKey(suggestKey(value));
    if (!repositoryEdited) setRepositoryName(slugify(value));
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitted(true);
    setRefusal(null);
    if (
      name.trim() === '' ||
      !keyValid ||
      !repositoryValid ||
      keyAvailability === 'taken' ||
      repositoryAvailability === 'taken'
    ) {
      return;
    }
    approve.reset();
    setAsking(true);
  }

  return (
    <form
      aria-label="The new project"
      className="space-y-4 rounded border border-slate-200 p-3"
      onSubmit={submit}
      noValidate
    >
      <div>
        <SubTitle>The new project</SubTitle>
        <p className="text-sm text-slate-600">
          Approving the plan creates this project and its repository on your GitHub account, as{' '}
          <Link to="/projects/new" className="text-blue-700 underline">
            New project
          </Link>{' '}
          does. To use an existing repository instead, reject the plan with feedback.
        </p>
      </div>
      <TextField
        label="Name"
        value={name}
        maxLength={100}
        error={nameError}
        onChange={(event) => {
          changeName(event.target.value);
        }}
      />
      <KeyField
        value={key}
        error={keyErrorText}
        onChange={(value) => {
          setKey(value);
          setKeyEdited(true);
          if (refusal?.field === 'key') setRefusal(null);
        }}
      />
      <div>
        <p className="font-medium text-slate-800">Kind</p>
        <p className="text-slate-800">{kindLabel[planned.kind]}</p>
        <p className="text-sm text-slate-600">
          <KindHint kind={planned.kind} />
        </p>
      </div>
      {planned.description !== '' && (
        <div>
          <p className="font-medium text-slate-800">Description</p>
          <p className="break-words text-slate-800">{planned.description}</p>
          <p className="text-sm text-slate-600">You can change it later in the project settings.</p>
        </div>
      )}
      <RepositoryNameField
        value={repositoryName}
        error={repositoryError}
        free={repositoryAvailability === 'free'}
        onChange={(value) => {
          setRepositoryName(value);
          setRepositoryEdited(true);
          if (refusal?.field === 'repository') setRefusal(null);
        }}
      />
      <VisibilityField isPrivate={isPrivate} onChange={setIsPrivate} />
      <Button type="submit">Approve</Button>
      {asking && (
        <ConfirmDialog
          title="Approve this plan?"
          confirmLabel="Approve"
          dismissLabel="Keep reviewing"
          busy={approve.isPending}
          error={approve.error && <Refusal error={approve.error} />}
          onConfirm={() => {
            approve.mutate();
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            {approveNewProjectText({
              ticketCount: plan.tickets.length,
              name: name.trim(),
              key,
              repository: account === null ? repositoryName : `${account}/${repositoryName}`,
              private: isPrivate,
            })}
          </p>
        </ConfirmDialog>
      )}
    </form>
  );
}

/** After the approval of a plan that created its project: where its setup is shown (answer 7). */
function CreatedProject({ request, plan }: { request: RequestDetail; plan: PlanView }) {
  if (plan.status !== 'approved' || plan.newProject === null || request.project === null) {
    return null;
  }
  const { key } = request.project;
  return (
    <p className="text-slate-700">
      Project {key} was created:{' '}
      <Link to={`/projects/${encodeURIComponent(key)}`} className="text-blue-700 underline">
        its setup is shown on its page
      </Link>
      .
    </p>
  );
}

/** **Reject with feedback**'s box, under the plan's actions (owner's answer 6, step F2). */
function RejectBox({
  request,
  plan,
  onClose,
}: {
  request: RequestDetail;
  plan: PlanView;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [missing, setMissing] = useState(false);
  const reject = useMutation({
    mutationFn: () =>
      api(
        'POST',
        planApi(request, '/reject'),
        RequestDetail,
        RejectPlanRequest.parse({ planId: plan.id, feedback: feedback.trim() }),
      ),
    onSuccess: async (detail) => {
      await requestsChanged(detail);
      onClose();
    },
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (feedback.trim() === '') {
      setMissing(true);
      return;
    }
    reject.mutate();
  }

  return (
    <form
      aria-label="Reject with feedback"
      className="space-y-2 rounded border border-slate-200 p-3"
      onSubmit={submit}
      noValidate
    >
      <TextArea
        label="What should change?"
        hint={`The Project Manager reads it to propose a new plan. ${MARKDOWN_HINT}`}
        rows={4}
        value={feedback}
        error={missing ? 'Write your feedback first.' : undefined}
        onChange={(event) => {
          setFeedback(event.target.value);
          setMissing(false);
          reject.reset();
        }}
      />
      <p className="text-slate-700">A new planning run starts: one Claude Code session.</p>
      {reject.error && <Refusal error={reject.error} />}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={reject.isPending}>
          Reject with feedback
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={reject.isPending}>
          Keep reviewing
        </Button>
      </div>
    </form>
  );
}

function PlanActions({ request, plan }: { request: RequestDetail; plan: PlanView }) {
  const [rejecting, setRejecting] = useState(false);
  const project = useProject(request.project?.key ?? '', request.project !== null);
  const archived = request.project !== null && project.data?.status === 'archived';
  const blocked = notApprovableText(
    request.project === null ? null : { key: request.project.key, archived },
  );
  // A plan creating a project is approved with its form (step G).
  const planned = request.project === null ? plan.newProject : null;
  return (
    <div className="space-y-3">
      {blocked && <p className="text-slate-700">{blocked}</p>}
      {planned !== null && !rejecting && (
        <NewProjectApproval request={request} plan={plan} planned={planned} />
      )}
      {!rejecting && (
        <div className="flex flex-wrap gap-3">
          {blocked === null && planned === null && project.data && (
            <ApproveAction request={request} plan={plan} />
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setRejecting(true);
            }}
          >
            Reject with feedback
          </Button>
        </div>
      )}
      {rejecting && (
        <RejectBox
          request={request}
          plan={plan}
          onClose={() => {
            setRejecting(false);
          }}
        />
      )}
    </div>
  );
}

/** The earlier plans, newest first, each folded (owner's answer 7, step F2). */
function EarlierPlans({ request }: { request: RequestDetail }) {
  if (request.earlierPlans.length === 0) return null;
  return (
    <section aria-label="Earlier plans">
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Earlier plans ({request.earlierPlans.length})
        </h2>
        <ul className="space-y-2">
          {request.earlierPlans.map((plan) => (
            <li key={plan.id}>
              <details className="rounded border border-slate-200 p-3">
                <summary className="cursor-pointer font-medium break-words text-slate-900">
                  {earlierPlanHeading(plan)}
                </summary>
                <div className="mt-3 space-y-3">
                  {plan.status === 'superseded' && plan.ownerFeedback !== null ? (
                    <div className="space-y-1">
                      <SubTitle>Your feedback</SubTitle>
                      <div className="min-w-0 break-words">
                        <UntrustedMarkdown>{plan.ownerFeedback}</UntrustedMarkdown>
                      </div>
                    </div>
                  ) : (
                    <p className="text-slate-700">Rejected: you closed the request.</p>
                  )}
                  {plan.summary !== '' && (
                    <div className="min-w-0 break-words">
                      <UntrustedMarkdown>{plan.summary}</UntrustedMarkdown>
                    </div>
                  )}
                  <NewProjectDetails plan={plan} />
                  <PlanGraph request={request} plan={plan} />
                  <PlanTickets request={request} plan={plan} editable={false} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** The plan section of the request page (02, section 5.3). */
export function PlanSection({ request }: { request: RequestDetail }) {
  const plan = request.plan;
  return (
    <>
      <section aria-label="Plan">
        <Card className="space-y-3">
          {plan === null ? (
            <>
              <h2 className="text-lg font-semibold text-slate-900">Plan</h2>
              <p className="text-slate-700">No plan yet.</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-slate-900">
                {plan.status === 'approved'
                  ? `Plan, approved by you${plan.decidedAt === null ? '' : ` at ${formatDateTime(plan.decidedAt)}`}`
                  : 'Plan'}
              </h2>
              <p className="text-sm text-slate-600">
                Proposed by the Project Manager at {formatDateTime(plan.proposedAt)}
              </p>
              {plan.summary !== '' && (
                <div className="min-w-0 break-words">
                  <UntrustedMarkdown>{plan.summary}</UntrustedMarkdown>
                </div>
              )}
              <NewProjectDetails plan={plan} />
              <CreatedProject request={request} plan={plan} />
              <PlanGraph request={request} plan={plan} />
              <PlanTickets request={request} plan={plan} editable={plan.status === 'proposed'} />
              {plan.status === 'proposed' && <PlanActions request={request} plan={plan} />}
            </>
          )}
        </Card>
      </section>
      <EarlierPlans request={request} />
    </>
  );
}
