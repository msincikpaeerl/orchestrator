import {
  GITHUB_TOKEN_LIST_URL,
  type AccountStatus,
  type NeedsYouItem,
} from '@orchestrator/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { UntrustedMarkdown } from '../components/markdown';
import { Card, HelpLink, InfoMessage, Loading, PageHeader } from '../components/ui';
import { formatDateTime, problemText } from '../github/text';
import { Command } from '../machines/command';
import { needsYouText, RESTART_COMMAND, type MachineNeedsYouItem } from '../machines/text';
import { sentence, stepLabel } from '../projects/text';
import { useGitHubStatus, useNeedsYou, useTicket } from '../queries';
import { AccountStatusText, QuestionAnswer, RunActions } from '../runs/components';
import { runPath } from '../runs/text';
import {
  AcceptAction,
  MarkDoneAction,
  RejectAction,
  RequestChangesAction,
  RunNowAction,
  RunNowOffer,
  SkipReviewAction,
  StartReviewAction,
  type TicketAddress,
} from '../tickets/actions';
import { readyForReviewText, reviewNotFinishedText } from '../tickets/review-text';
import { CheckCiAgainAction } from '../tickets/check-ci-again';
import { ciTimeoutItemText } from '../runs/ci-outcome-text';
import { PullRequestFailureDetails } from '../tickets/submission';
import { pullRequestNotOpenedText, pushFailedText, ticketPath, ticketRef } from '../tickets/text';

function itemKey(item: NeedsYouItem): string {
  switch (item.type) {
    case 'project_setup_failed':
      return `${item.type}-${item.project.key}`;
    case 'question':
    case 'ticket_proposed':
    case 'work_to_check':
    case 'ready_for_review':
    case 'review_not_finished':
    case 'push_failed':
    case 'pull_request_not_opened':
    case 'ci_timeout':
    case 'ticket_stopped':
      return `${item.type}-${item.ticket.projectKey}-${String(item.ticket.number)}`;
    case 'run_paused':
      return `${item.type}-${item.run.id}`;
    case 'no_claude_account':
    case 'no_machine':
      return item.type;
    default:
      return `${item.type}-${item.machine.id}`;
  }
}

/** The compact status line of each Claude account (02, section 4), updated when a limit passes. */
function AccountStatusLines({ accounts }: { accounts: AccountStatus[] }) {
  if (accounts.length === 0) return null;
  return (
    <ul aria-label="Claude accounts" className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-slate-700">
      {accounts.map((account) => (
        <li key={account.id} className="break-words">
          <span className="font-medium text-slate-900">{account.label}</span>:{' '}
          <AccountStatusText account={account} />
        </li>
      ))}
    </ul>
  );
}

function TicketTitle({
  ticket,
}: {
  ticket: { projectKey: string; number: number; title: string };
}) {
  return (
    <Link
      to={ticketPath(ticket.projectKey, ticket.number)}
      className="break-words text-blue-700 underline"
    >
      {ticketRef(ticket.projectKey, ticket.number)} · {ticket.title}
    </Link>
  );
}

/** A ticket's **Mark as done manually**, which needs the ticket's dependencies for its warning. */
function MarkDone({ ticket }: { ticket: TicketAddress }) {
  const detail = useTicket(ticket.projectKey, ticket.number);
  return detail.data ? <MarkDoneAction ticket={detail.data} /> : null;
}

/** What agents' work leaves for the owner (02, section 4), with the actions of the ticket page. */
function WorkItemCard({
  item,
  onChangesRequested,
}: {
  item: Extract<
    NeedsYouItem,
    { type: 'question' | 'ticket_proposed' | 'work_to_check' | 'run_paused' }
  >;
  onChangesRequested: (ticket: TicketAddress) => void;
}) {
  switch (item.type) {
    case 'question':
      return (
        <Card className="space-y-2">
          <TicketTitle ticket={item.ticket} />
          <QuestionAnswer ticket={item.ticket} question={item.question} />
        </Card>
      );
    case 'ticket_proposed':
      return (
        <Card className="space-y-2">
          <h2 className="font-semibold text-slate-900">
            Ticket proposed by {item.agent ? `agent ${item.agent.name}` : 'an agent'}
          </h2>
          <TicketTitle ticket={item.ticket} />
          <p className="text-sm text-slate-600">{formatDateTime(item.since)}</p>
          <div className="flex flex-wrap items-start gap-2">
            <AcceptAction ticket={item.ticket} />
            <RejectAction ticket={item.ticket} />
          </div>
        </Card>
      );
    case 'work_to_check':
      return (
        <Card className="space-y-2">
          <h2 className="font-semibold text-slate-900">Work finished: check it</h2>
          <TicketTitle ticket={item.ticket} />
          <p className="text-sm text-slate-600">Submitted {formatDateTime(item.since)}</p>
          {item.summary !== null && (
            <section aria-label="Summary of the work" className="text-slate-800">
              <UntrustedMarkdown>{item.summary}</UntrustedMarkdown>
            </section>
          )}
          <div className="flex flex-wrap items-start gap-2">
            <MarkDone ticket={item.ticket} />
            <RequestChangesAction
              ticket={item.ticket}
              onRequested={() => {
                onChangesRequested(item.ticket);
              }}
            />
            {item.runId !== null && (
              <Link to={runPath(item.runId)} className="self-center text-blue-700 underline">
                Open the run
              </Link>
            )}
          </div>
        </Card>
      );
    case 'run_paused':
      return (
        <Card className="space-y-2">
          <h2 className="font-semibold text-slate-900">
            {item.run.pauseReason === 'suspected_usage_limit'
              ? 'Run paused: possible Claude usage limit'
              : 'Run paused: Claude usage limit reached'}
          </h2>
          <TicketTitle ticket={item.ticket} />
          <RunActions run={item.run} />
          <Link to={runPath(item.run.id)} className="text-blue-700 underline">
            Open the run
          </Link>
        </Card>
      );
  }
}

/**
 * "Ready for review" (02, section 4; owner's answers 4 and 5, lot 3 step H): the pull request, the
 * CI line, the workflow line, what each choice costs, **Start review** and **Skip review**.
 */
function ReadyForReviewCard({
  item,
}: {
  item: Extract<NeedsYouItem, { type: 'ready_for_review' }>;
}) {
  const text = readyForReviewText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{text.title}</h2>
      <TicketTitle ticket={item.ticket} />
      <p>
        <a
          href={item.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="text-blue-700 underline"
        >
          Pull request #{item.pullRequest.number}
        </a>
      </p>
      <p className="break-words text-slate-700">{text.ci}</p>
      {text.workflows && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 break-words text-slate-800">
          {text.workflows}
        </p>
      )}
      <p className="text-slate-700">{text.cost}</p>
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <div className="flex flex-wrap items-start gap-2">
        <StartReviewAction ticket={item.ticket} />
        <SkipReviewAction ticket={item.ticket} />
      </div>
      <HelpLink page="tickets#review-by-quality">Review by Quality</HelpLink>
    </Card>
  );
}

/**
 * "Review did not finish" (02, section 4; owner's answers 2, 3 and 5): why, or which decision was
 * not applied and why, with **Start review** and **Skip review**.
 */
function ReviewNotFinishedCard({
  item,
}: {
  item: Extract<NeedsYouItem, { type: 'review_not_finished' }>;
}) {
  const { title, detail } = reviewNotFinishedText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <TicketTitle ticket={item.ticket} />
      <p className="break-words text-slate-700">{detail}</p>
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <div className="flex flex-wrap items-start gap-2">
        <StartReviewAction ticket={item.ticket} />
        <SkipReviewAction ticket={item.ticket} />
      </div>
      <div className="flex flex-wrap gap-4">
        <Link to={runPath(item.runId)} className="text-blue-700 underline">
          Open the run
        </Link>
        <HelpLink page="tickets#review-by-quality">What to do</HelpLink>
      </div>
    </Card>
  );
}

/** A push GitHub refused or could not take (04, section 5): what happened, what to do. */
function PushFailedCard({ item }: { item: Extract<NeedsYouItem, { type: 'push_failed' }> }) {
  const { title, detail } = pushFailedText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <TicketTitle ticket={item.ticket} />
      <p className="break-words text-slate-700">{detail}</p>
      {item.reason === 'refused' && item.permission === null && (
        <pre
          aria-label="GitHub's words"
          className="overflow-x-auto rounded bg-slate-100 p-2 text-sm whitespace-pre-wrap break-words text-slate-800"
        >
          {item.message}
        </pre>
      )}
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <div className="flex flex-wrap gap-4">
        {item.permission !== null && (
          <a
            href={GITHUB_TOKEN_LIST_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 underline"
          >
            Open your tokens on GitHub
          </a>
        )}
        <Link
          to={ticketPath(item.ticket.projectKey, item.ticket.number)}
          className="text-blue-700 underline"
        >
          Open the ticket
        </Link>
        <HelpLink page="tickets#when-the-work-cannot-be-pushed-to-github">What to do</HelpLink>
      </div>
    </Card>
  );
}

/**
 * A ticket stopped by the retry policy (04, section 5; lot 3 step I). Step I2 adds **Try again**,
 * **Cancel** and **Mark as done manually** to the card; the ticket page has them meanwhile.
 */
function TicketStoppedCard({ item }: { item: Extract<NeedsYouItem, { type: 'ticket_stopped' }> }) {
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">
        {item.cause === 'review_rounds'
          ? 'Stopped after too many review rounds'
          : 'Stopped after repeated failures'}
      </h2>
      <TicketTitle ticket={item.ticket} />
      <p className="break-words text-slate-700">
        {item.cause === 'review_rounds'
          ? `Quality requested changes ${String(item.count)} times, more than Most review rounds per ticket allows (${String(item.limit)}).`
          : `It failed ${String(item.count)} times, more than Failed attempts before asking you allows (${String(item.limit)}).`}{' '}
        Use Try again to let it continue, or Cancel it, or Mark it as done manually.
      </p>
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <Link
        to={ticketPath(item.ticket.projectKey, item.ticket.number)}
        className="text-blue-700 underline"
      >
        Open the ticket
      </Link>
    </Card>
  );
}

/**
 * An accepted submission whose pull request was not opened (04, section 3.1; lot 3 step F3): what
 * happened, where to fix it, and **Try again** (one attempt; the row goes when it succeeds).
 */
function PullRequestNotOpenedCard({
  item,
}: {
  item: Extract<NeedsYouItem, { type: 'pull_request_not_opened' }>;
}) {
  const { title } = pullRequestNotOpenedText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <TicketTitle ticket={item.ticket} />
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <PullRequestFailureDetails
        ticket={item.ticket}
        failure={item.failure}
        openPullRequest={item.openPullRequest}
      />
    </Card>
  );
}

/**
 * A run ended at **CI wait at submission** (04, section 3.1; owner's answer 1, lot 3 step G2c):
 * "CI did not finish" with **Check CI again**, or a failure or a conflict the agent did not get,
 * with **Run now**.
 */
function CiTimeoutCard({
  item,
  onAccepted,
}: {
  item: Extract<NeedsYouItem, { type: 'ci_timeout' }>;
  onAccepted: (said: string) => void;
}) {
  const { title, detail } = ciTimeoutItemText(item);
  const notFinished = item.outcome.kind === 'not_finished';
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <TicketTitle ticket={item.ticket} />
      <p className="break-words text-slate-700">{detail}</p>
      <p className="text-sm text-slate-600">Since {formatDateTime(item.since)}</p>
      <div className="flex flex-wrap items-start gap-2">
        {notFinished ? (
          item.pullRequest !== null && (
            <CheckCiAgainAction ticket={item.ticket} runId={item.runId} onAccepted={onAccepted} />
          )
        ) : (
          <RunNowAction ticket={item.ticket} />
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <Link to={runPath(item.runId)} className="text-blue-700 underline">
          Open the run
        </Link>
        <Link
          to={ticketPath(item.ticket.projectKey, item.ticket.number)}
          className="text-blue-700 underline"
        >
          Open the ticket
        </Link>
        <HelpLink page="tickets#check-ci-again">What to do</HelpLink>
      </div>
    </Card>
  );
}

/** Setup still to do and machine problems (02, section 4), with where to fix them. */
function MachineItemCard({ item }: { item: MachineNeedsYouItem }) {
  const { title, detail } = needsYouText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <p className="break-words text-slate-700">{detail}</p>
      {item.type === 'machine_problem' && (
        <ul className="list-disc space-y-1 pl-6 text-slate-700">
          {item.checks.map((check) => (
            <li key={check.name} className="break-words">
              {check.name}: {check.message}
            </li>
          ))}
        </ul>
      )}
      {(item.type === 'daemon_incompatible' ||
        item.type === 'daemon_outdated' ||
        item.type === 'daemon_build_differs') && (
        <Command command={item.updateCommands.join('\n')} label="Update commands" />
      )}
      {(item.type === 'claude_code_unsupported' || item.type === 'machine_problem') && (
        <Command command={RESTART_COMMAND} label="Restart command" />
      )}
      <div className="flex flex-wrap gap-4">
        {item.type === 'no_claude_account' ? (
          <>
            <Link to="/machines" className="text-blue-700 underline">
              Open Machines
            </Link>
            <HelpLink page="machines#add-a-claude-account">How to add it</HelpLink>
          </>
        ) : item.type === 'no_machine' ? (
          <>
            <Link to="/machines/new" className="text-blue-700 underline">
              Add machine
            </Link>
            <HelpLink page="machines#add-a-machine">How to add a machine</HelpLink>
          </>
        ) : (
          <>
            <Link to={`/machines/${item.machine.id}`} className="text-blue-700 underline">
              Open the machine
            </Link>
            <HelpLink
              page={
                item.type === 'daemon_incompatible' ||
                item.type === 'daemon_outdated' ||
                item.type === 'daemon_build_differs'
                  ? 'machines#update-the-daemon'
                  : 'machines#when-a-machine-has-a-problem'
              }
            >
              What to do
            </HelpLink>
          </>
        )}
      </div>
    </Card>
  );
}

/** Home page: everything waiting for the owner (02, section 4). */
export function NeedsYouPage() {
  const github = useGitHubStatus();
  const needsYou = useNeedsYou();
  // After Request changes the item leaves the list: the page offers Run now (L2).
  const [offer, setOffer] = useState<TicketAddress | null>(null);
  // Check CI again accepted the work: its item is gone, the page says what happened.
  const [accepted, setAccepted] = useState<string | null>(null);
  if (github.isPending || needsYou.isPending) return <Loading />;
  const problems = github.data?.connected ? github.data.problems : [];
  const items = needsYou.data?.items ?? [];

  return (
    <>
      <PageHeader title="Needs you" help="needs-you" />
      <AccountStatusLines accounts={needsYou.data?.accounts ?? []} />
      {offer && (
        <RunNowOffer
          ticket={offer}
          onClose={() => {
            setOffer(null);
          }}
        />
      )}
      {accepted && (
        <div role="status" className="mb-3">
          <InfoMessage>{accepted}</InfoMessage>
        </div>
      )}
      {needsYou.isError && (
        <p role="alert" className="mb-3 text-red-800">
          Some items could not be loaded. Reload the page.
        </p>
      )}
      {problems.length === 0 && items.length === 0 ? (
        <Card>
          <p>Nothing needs you right now.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {problems.map((problem, index) => {
            const { title, detail } = problemText(problem);
            return (
              <li key={`${problem.type}-${String(index)}`}>
                <Card className="space-y-2">
                  <h2 className="font-semibold text-slate-900">{title}</h2>
                  <p className="text-slate-700">{detail}</p>
                  <div className="flex flex-wrap gap-4">
                    <Link to="/settings/github" className="text-blue-700 underline">
                      Open GitHub connection
                    </Link>
                    <HelpLink page="github-token">How to create the token</HelpLink>
                  </div>
                </Card>
              </li>
            );
          })}
          {items.map((item) => (
            <li key={itemKey(item)}>
              {item.type === 'project_setup_failed' ? (
                <Card className="space-y-2">
                  <h2 className="font-semibold break-words text-slate-900">
                    Project setup failed: {item.project.key} · {item.project.name}
                  </h2>
                  <p className="break-words text-slate-700">
                    Step “{stepLabel[item.step]}”: {sentence(item.reason)}
                  </p>
                  <div className="flex flex-wrap gap-4">
                    <Link to={`/projects/${item.project.key}`} className="text-blue-700 underline">
                      Open the project
                    </Link>
                    <HelpLink page="projects#if-the-setup-fails">What to do</HelpLink>
                  </div>
                </Card>
              ) : item.type === 'question' ||
                item.type === 'ticket_proposed' ||
                item.type === 'work_to_check' ||
                item.type === 'run_paused' ? (
                <WorkItemCard item={item} onChangesRequested={setOffer} />
              ) : item.type === 'ready_for_review' ? (
                <ReadyForReviewCard item={item} />
              ) : item.type === 'review_not_finished' ? (
                <ReviewNotFinishedCard item={item} />
              ) : item.type === 'push_failed' ? (
                <PushFailedCard item={item} />
              ) : item.type === 'pull_request_not_opened' ? (
                <PullRequestNotOpenedCard item={item} />
              ) : item.type === 'ci_timeout' ? (
                <CiTimeoutCard item={item} onAccepted={setAccepted} />
              ) : item.type === 'ticket_stopped' ? (
                <TicketStoppedCard item={item} />
              ) : (
                <MachineItemCard item={item} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
