import {
  GITHUB_TOKEN_LIST_URL,
  PullRequestTryAgainResponse,
  type DodCheckResult,
  type DodReport,
  type PullRequestFailure,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Button, ErrorMessage, HelpLink } from '../components/ui';
import { ticketsChanged } from '../queries';
import { refusalText } from '../refusals';
import { SKIPPED_TEXT, checkTitle, reasonText, resultLabel } from './check-text';
import { pullRequestFailureText, ticketPath, ticketRef } from './text';

// A submission as the ticket page (the accepted one) and the run page (the latest refused one)
// show it (02, sections 6.4 and 7; lot 3 step F4). Every path, justification and message here was
// written by an agent, or holds its words: shown as plain text, never as HTML or Markdown (ADR
// 0024), and masked by the server before it reaches the browser.

/**
 * Display constant (not a setting, 04 section 8): items of a list shown before the others are
 * folded under "Show the other N", so a list of hundreds of files stays readable on a phone.
 */
export const SUBMISSION_LIST_SHOWN = 10;

/** Agent text: a long path breaks anywhere rather than widening the page. */
const agentText = 'break-words [overflow-wrap:anywhere]';

function Folded<T>({
  items,
  noun,
  render,
  label,
}: {
  items: readonly T[];
  noun: [one: string, many: string];
  render: (item: T, index: number) => ReactNode;
  label: string;
}) {
  const shown = items.slice(0, SUBMISSION_LIST_SHOWN);
  const rest = items.slice(SUBMISSION_LIST_SHOWN);
  return (
    <>
      <ul aria-label={label} className="list-disc space-y-1 pl-5">
        {shown.map(render)}
      </ul>
      {rest.length > 0 && (
        <details>
          <summary className="cursor-pointer text-blue-700 underline">
            Show the other {rest.length.toLocaleString('en-US')}{' '}
            {rest.length === 1 ? noun[0] : noun[1]}
          </summary>
          <ul aria-label={`${label}, continued`} className="mt-1 list-disc space-y-1 pl-5">
            {rest.map((item, index) => render(item, index + SUBMISSION_LIST_SHOWN))}
          </ul>
        </details>
      )}
    </>
  );
}

const resultStyle: Record<DodCheckResult['result'], string> = {
  passed: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  incomplete: 'bg-amber-100 text-amber-900',
  skipped: 'bg-slate-100 text-slate-800',
};

/** Each check with its result; why, in the owner's words, when it failed or was not fully done. */
export function CheckList({ checks }: { checks: readonly DodCheckResult[] }) {
  return (
    <ul aria-label="Checks" className="space-y-3">
      {checks.map((each) => (
        <li key={each.check} className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{checkTitle(each.check)}</span>
            <span className={`rounded px-2 py-0.5 text-sm ${resultStyle[each.result]}`}>
              {resultLabel[each.result]}
            </span>
          </p>
          {each.result === 'skipped' && <p className="text-slate-700">{SKIPPED_TEXT}</p>}
          {each.reasons.length > 0 && (
            <Folded
              items={each.reasons}
              noun={['reason', 'reasons']}
              label={`Why: ${checkTitle(each.check)}`}
              render={(reason, index) => (
                <li key={index} className={`text-slate-700 ${agentText}`}>
                  {reasonText(reason)}
                </li>
              )}
            />
          )}
          {each.messages.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-600 underline">
                What the agent was told
              </summary>
              <ul
                aria-label={`What the agent was told: ${checkTitle(each.check)}`}
                className="mt-1 space-y-1 border-l-4 border-slate-200 pl-3"
              >
                {each.messages.map((message, index) => (
                  <li key={index} className={`whitespace-pre-wrap text-slate-700 ${agentText}`}>
                    {message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function FilesPart({
  title,
  paths,
  justification,
}: {
  title: string;
  paths: readonly string[];
  justification: string | null;
}) {
  return (
    <div className="space-y-1">
      <h4 className="font-medium text-slate-900">{title}</h4>
      {paths.length > 0 && (
        <Folded
          items={paths}
          noun={['file', 'files']}
          label={title}
          render={(path, index) => (
            <li key={index} className={agentText}>
              <code className="rounded bg-slate-100 px-1 text-sm">{path}</code>
            </li>
          )}
        />
      )}
      {justification !== null && (
        <p className={`text-slate-700 ${agentText}`}>
          {paths.length > 0 ? 'Also: ' : 'None, because: '}
          {justification}
        </p>
      )}
      {paths.length === 0 && justification === null && <p className="text-slate-700">None.</p>}
    </div>
  );
}

/** The tests, documentation and architecture decisions the agent listed. */
export function ReportFiles({ report }: { report: DodReport }) {
  return (
    <div className="space-y-3">
      <FilesPart title="Tests" {...report.tests} />
      <FilesPart title="Documentation" {...report.docs} />
      <FilesPart title="Architecture decisions" paths={report.adrs} justification={null} />
    </div>
  );
}

/**
 * "Pull request not opened" (04, section 3.1): what happened, GitHub's words or the fields that
 * differed, where to fix it, and **Try again** (one attempt, answered once made). `inTicket`
 * leaves out the link to the ticket, on the ticket's own page.
 */
export function PullRequestFailureDetails({
  ticket,
  failure,
  inTicket = false,
}: {
  ticket: { projectKey: string; number: number };
  failure: PullRequestFailure;
  inTicket?: boolean;
}) {
  const { detail, where, showMessage } = pullRequestFailureText(
    ticketRef(ticket.projectKey, ticket.number),
    failure,
  );
  const tryAgain = useMutation({
    mutationFn: () =>
      api(
        'POST',
        `/api/projects/${ticket.projectKey}/tickets/${String(ticket.number)}/pull-request/try-again`,
        PullRequestTryAgainResponse,
      ),
    onSettled: () => ticketsChanged(),
  });
  return (
    <>
      <p className="break-words text-slate-700">{detail}</p>
      {showMessage && (
        <pre
          aria-label="GitHub's words"
          className={`overflow-x-auto rounded bg-slate-100 p-2 text-sm whitespace-pre-wrap text-slate-800 ${agentText}`}
        >
          {failure.message}
        </pre>
      )}
      {failure.fields.length > 0 && (
        <ul aria-label="Fields that differed" className="list-disc pl-5 text-sm text-slate-700">
          {failure.fields.map((field) => (
            <li key={field} className={agentText}>
              {field}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button
          onClick={() => {
            tryAgain.mutate();
          }}
          disabled={tryAgain.isPending}
        >
          {tryAgain.isPending ? 'Trying again…' : 'Try again'}
        </Button>
        {where === 'tokens' && (
          <a
            href={GITHUB_TOKEN_LIST_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 underline"
          >
            Open your tokens on GitHub
          </a>
        )}
        {where === 'settings' && (
          <Link to="/settings/github" className="text-blue-700 underline">
            Open GitHub connection
          </Link>
        )}
        {!inTicket && (
          <Link
            to={ticketPath(ticket.projectKey, ticket.number)}
            className="text-blue-700 underline"
          >
            Open the ticket
          </Link>
        )}
        <HelpLink page="needs-you#pull-request-not-opened">What to do</HelpLink>
      </div>
      {tryAgain.error && <ErrorMessage>{refusalText(tryAgain.error)}</ErrorMessage>}
      {tryAgain.data?.failure && (
        <p role="status" className="text-sm text-slate-700">
          Tried again: still not opened.
        </p>
      )}
    </>
  );
}
