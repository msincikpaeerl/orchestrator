import {
  AddCommentRequest,
  CreateRequestRequest,
  RequestDetail,
  RequestNumber,
  type Comment,
  type RequestSummary,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api';
import { UntrustedMarkdown } from '../components/markdown';
import {
  Button,
  buttonLinkClass,
  Card,
  ErrorMessage,
  Loading,
  PageHeader,
  SelectField,
  TextArea,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { requestsChanged, useProjects, useRequest, useRequests } from '../queries';
import { refusalText } from '../refusals';
import {
  requestCommentAuthor,
  requestName,
  ENDED_QUESTION_TEXT,
  planningStoppedText,
  requestOpenQuestion,
  requestPath,
  requestStatusLabel,
} from '../requests/text';
import { RequestTryAgain } from '../requests/try-again';
import { QuestionAnswer } from '../runs/components';
import { runPath } from '../runs/text';

const MARKDOWN_HINT = 'Markdown is allowed. Links open in a new tab; images are shown as links.';

/** The value of "a new project" in the project field. */
const NEW_PROJECT = '';

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-semibold text-slate-900">{children}</h2>;
}

function StatusBadge({ request }: { request: RequestSummary }) {
  return (
    <span className="rounded bg-slate-100 px-2 py-0.5 text-sm text-slate-800">
      {requestStatusLabel[request.status]}
    </span>
  );
}

/** "For WEB · Bakery website", or "For a new project". */
function projectText(request: RequestSummary): string {
  return request.project === null
    ? 'For a new project'
    : `For ${request.project.key} · ${request.project.name}`;
}

/** Requests (02, section 5.1): open and closed, newest first, with their status and project. */
export function RequestsPage() {
  const requests = useRequests();
  return (
    <>
      <PageHeader title="Requests" help="requests" />
      <div className="mb-4">
        <Link to="/requests/new" className={buttonLinkClass}>
          New request
        </Link>
      </div>
      {requests.isPending ? (
        <Loading />
      ) : requests.isError ? (
        <ErrorMessage>The requests could not be loaded. Reload the page.</ErrorMessage>
      ) : requests.data.requests.length === 0 ? (
        <Card>
          <p>
            No request yet. Click <strong>New request</strong> to describe, in your own words, what
            you want built or changed.
          </p>
        </Card>
      ) : (
        <ul aria-label="Requests" className="space-y-3">
          {requests.data.requests.map((request) => (
            <li key={request.number}>
              <Card className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={requestPath(request.number)}
                    className="font-semibold break-words text-blue-700 underline"
                  >
                    {requestName(request.number)} · {request.line}
                  </Link>
                  <StatusBadge request={request} />
                </div>
                <p className="break-words text-slate-700">{projectText(request)}</p>
                <p className="text-sm text-slate-600">
                  Submitted {formatDateTime(request.createdAt)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** New request (02, section 5.2): the text, and a project or "a new project". */
export function NewRequestPage() {
  const navigate = useNavigate();
  const projects = useProjects(false);
  const [body, setBody] = useState('');
  const [project, setProject] = useState(NEW_PROJECT);
  const [missing, setMissing] = useState(false);
  const submit = useMutation({
    mutationFn: () =>
      api(
        'POST',
        '/api/requests',
        RequestDetail,
        CreateRequestRequest.parse({
          body: body.trim(),
          project: project === NEW_PROJECT ? null : project,
        }),
      ),
    onSuccess: async (request) => {
      await requestsChanged(request);
      await navigate(requestPath(request.number));
    },
  });
  // Archived projects are left out: they are read-only (owner's answer 9, lot 5 step D).
  const listed = (projects.data?.projects ?? []).filter((each) => each.status === 'active');

  function send(event: SubmitEvent) {
    event.preventDefault();
    if (body.trim() === '') {
      setMissing(true);
      return;
    }
    submit.mutate();
  }

  return (
    <>
      <PageHeader title="New request" help="requests#submit-a-request" />
      <Card>
        <form className="space-y-5" onSubmit={send} noValidate>
          <TextArea
            label="What do you want?"
            hint={`Describe it in your own words: what it is for, who uses it, what matters to you. ${MARKDOWN_HINT}`}
            rows={8}
            value={body}
            error={missing ? 'Write your request first.' : undefined}
            onChange={(event) => {
              setBody(event.target.value);
              setMissing(false);
              submit.reset();
            }}
          />
          <SelectField
            label="Project"
            hint="The project this request is about, or a new project: the Project Manager then proposes one."
            value={project}
            disabled={projects.isPending}
            onChange={(event) => {
              setProject(event.target.value);
              submit.reset();
            }}
          >
            <option value={NEW_PROJECT}>A new project</option>
            {listed.map((each) => (
              <option key={each.key} value={each.key}>
                {each.key} · {each.name}
              </option>
            ))}
          </SelectField>
          <p className="text-slate-700">
            When you submit, the request waits as Open until the scheduler starts the Project
            Manager on it, as soon as a machine is free.
          </p>
          {submit.error && <ErrorMessage>{refusalText(submit.error)}</ErrorMessage>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submit.isPending}>
              Submit the request
            </Button>
            <Link to="/requests" className="text-blue-700 underline">
              Back without submitting
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  return (
    <li className="space-y-1 border-l-4 border-blue-200 pl-3">
      <p className="text-sm text-slate-600">
        {requestCommentAuthor(comment)} · {formatDateTime(comment.createdAt)}
      </p>
      <UntrustedMarkdown>{comment.body}</UntrustedMarkdown>
    </li>
  );
}

/** The conversation with the Project Manager, oldest first, and the owner's note. */
function Conversation({ request }: { request: RequestDetail }) {
  const [body, setBody] = useState('');
  const [missing, setMissing] = useState(false);
  const addComment = useMutation({
    mutationFn: (input: AddCommentRequest) =>
      api('POST', `/api/requests/${String(request.number)}/comments`, RequestDetail, input),
    onSuccess: (changed) => requestsChanged(changed),
    onError: () => requestsChanged(),
  });

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
      <SectionTitle>Conversation</SectionTitle>
      {request.comments.length === 0 ? (
        <p className="text-slate-700">No comments yet.</p>
      ) : (
        <ol aria-label="Conversation" className="space-y-4">
          {request.comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </ol>
      )}
      <form className="space-y-2" onSubmit={submit} noValidate>
        <TextArea
          label="Add a comment"
          hint={`Anything to add to your request. ${MARKDOWN_HINT}`}
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
    </Card>
  );
}

function RequestContent({ number }: { number: number }) {
  const request = useRequest(number);
  if (request.isPending) return <Loading />;
  if (request.isError) {
    const missing =
      request.error instanceof ApiRequestError && request.error.code === 'request_not_found';
    return (
      <div className="space-y-3">
        <ErrorMessage>
          {missing
            ? 'This request does not exist.'
            : 'The request could not be loaded. Reload the page.'}
        </ErrorMessage>
        <Link to="/requests" className="text-blue-700 underline">
          Back to the requests
        </Link>
      </div>
    );
  }
  const data = request.data;
  const question = requestOpenQuestion(data);
  return (
    <>
      <PageHeader title={`${requestName(data.number)} · ${data.line}`} help="requests" />
      <div className="space-y-4">
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge request={data} />
            <span className="break-words text-slate-700">
              {data.project === null ? (
                'For a new project'
              ) : (
                <>
                  For{' '}
                  <Link to={`/projects/${data.project.key}`} className="text-blue-700 underline">
                    {data.project.key} · {data.project.name}
                  </Link>
                </>
              )}
            </span>
          </div>
          <p className="text-sm text-slate-600">Submitted {formatDateTime(data.createdAt)}</p>
          <section aria-label="Request" className="min-w-0 break-words">
            <UntrustedMarkdown>{data.body}</UntrustedMarkdown>
          </section>
          {data.status === 'open' && (
            <p className="text-slate-700">
              Open: the request waits for the Project Manager. The scheduler starts its planning run
              when a machine is free; Activity {'>'} Queue says why it waits.
            </p>
          )}
          {data.status === 'planning' && (
            <p className="text-slate-700">
              {question?.live
                ? 'Planning: the Project Manager waits for your answer.'
                : 'Planning: the Project Manager is working on it.'}
              {data.run && (
                <>
                  {' '}
                  <Link to={runPath(data.run.id)} className="text-blue-700 underline">
                    See the run
                  </Link>
                </>
              )}
            </p>
          )}
        </Card>
        {data.stopped && (
          <section aria-label="Planning stopped">
            <Card className="space-y-2">
              <SectionTitle>Planning stopped</SectionTitle>
              <p className="break-words text-slate-700">{planningStoppedText(data.stopped)}</p>
              <RequestTryAgain number={data.number} />
            </Card>
          </section>
        )}
        {question && (
          <div className="space-y-2">
            <QuestionAnswer
              key={question.question.id}
              target={{ request: data.number }}
              question={question.question}
            />
            {!question.live && <p className="text-slate-700">{ENDED_QUESTION_TEXT}</p>}
          </div>
        )}
        <Card className="space-y-2">
          <SectionTitle>Plan</SectionTitle>
          <p className="text-slate-700">No plan yet.</p>
        </Card>
        <Conversation request={data} />
      </div>
    </>
  );
}

/** Request detail (02, section 5.3): its text, status, plan and conversation. */
export function RequestPage() {
  const { number = '' } = useParams();
  const parsed = /^[1-9]\d{0,9}$/.test(number) ? RequestNumber.safeParse(Number(number)) : null;
  if (!parsed?.success) {
    return (
      <div className="space-y-3">
        <ErrorMessage>This request does not exist.</ErrorMessage>
        <Link to="/requests" className="text-blue-700 underline">
          Back to the requests
        </Link>
      </div>
    );
  }
  return <RequestContent number={parsed.data} />;
}
