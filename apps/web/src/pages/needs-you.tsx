import type { AccountStatus, NeedsYouItem } from '@orchestrator/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { UntrustedMarkdown } from '../components/markdown';
import { Card, HelpLink, Loading, PageHeader } from '../components/ui';
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
  RunNowOffer,
  type TicketAddress,
} from '../tickets/actions';
import { ticketPath, ticketRef } from '../tickets/text';

function itemKey(item: NeedsYouItem): string {
  switch (item.type) {
    case 'project_setup_failed':
      return `${item.type}-${item.project.key}`;
    case 'question':
    case 'ticket_proposed':
    case 'work_to_check':
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
      {item.type === 'daemon_incompatible' && (
        <>
          <Command command={item.updateCommand} label="Update command" />
          <Command command={RESTART_COMMAND} label="Restart command" />
        </>
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
            <HelpLink page="machines#when-a-machine-has-a-problem">What to do</HelpLink>
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
