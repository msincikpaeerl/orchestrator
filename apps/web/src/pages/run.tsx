import type { RunDetail } from '@orchestrator/protocol';
import { Link, useParams } from 'react-router';
import { ApiRequestError } from '../api';
import { Card, ErrorMessage, InfoMessage, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../github/text';
import { useRun, useTicket } from '../queries';
import { CiWaitCard } from '../runs/ci-card';
import { AnswerBox, CommitList, LogEntry, RunActions, RunTimes } from '../runs/components';
import { useRunLog } from '../runs/log';
import { acceptedAfterText, isActive, purposeLabel, runStateText, usageText } from '../runs/text';
import { runPushText } from '../tickets/branch-text';
import { CheckList, ReportFiles } from '../tickets/submission';
import { ticketPath } from '../tickets/text';

/** The ticket's number in `WEB-12`. */
function ticketNumber(run: RunDetail): number {
  return Number(run.ticket.slice(run.projectKey.length + 1));
}

/** The answer box while the run waits for the owner's answer (owner's decision, lot 2 step L). */
function RunQuestion({ run }: { run: RunDetail }) {
  const ticket = useTicket(run.projectKey, ticketNumber(run));
  if (run.status !== 'waiting_human' || !ticket.data) return null;
  return <AnswerBox ticket={ticket.data} />;
}

function RunLog({ run }: { run: RunDetail }) {
  const { entries, error } = useRunLog(run.id);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Log</h2>
      <p className="text-sm text-slate-600">
        What the agent does, as it happens{isActive(run.status) ? '' : ' (the run has ended)'}. Long
        results are shortened; passwords and tokens are hidden.
      </p>
      {error && <ErrorMessage>The log could not be loaded. It is read again shortly.</ErrorMessage>}
      {entries.length === 0 ? (
        <p className="text-slate-700">Nothing yet.</p>
      ) : (
        <ol aria-label="Log" className="space-y-2">
          {entries.map((entry) => (
            <LogEntry key={entry.seq} entry={entry} />
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * The run's latest refused submission (02, section 7; lot 3 step F4): each check's result and
 * why, so the owner sees why an agent was refused, also one refused again and again.
 */
function RefusedSubmission({ run }: { run: RunDetail }) {
  const refused = run.refusedSubmission;
  if (!refused) return null;
  const accepted = acceptedAfterText(run);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Latest refused submission</h2>
      <p className="text-slate-700">
        The agent handed in its work on {formatDateTime(refused.at)}, and the checks refused it. A
        refused agent fixes its work and hands it in again in the same run, except when the branch
        could not be pushed to GitHub.
      </p>
      {accepted && (
        <p
          className="rounded border border-green-300 bg-green-50 px-3 py-2 text-slate-900"
          aria-label="Accepted afterwards"
        >
          {accepted} The results below are those of the earlier, refused submission.
        </p>
      )}
      <CheckList checks={refused.checks} />
      <details>
        <summary className="cursor-pointer text-blue-700 underline">Files the agent listed</summary>
        <div className="mt-2">
          <ReportFiles report={refused.report} />
        </div>
      </details>
    </Card>
  );
}

function RunContent({ run }: { run: RunDetail }) {
  const number = ticketNumber(run);
  return (
    <>
      <PageHeader title={`Run of ${run.ticket} · attempt ${String(run.attempt)}`} help="runs" />
      <div className="space-y-4">
        <Link
          to={ticketPath(run.projectKey, number)}
          className="inline-block text-blue-700 underline"
        >
          Back to {run.ticket}
        </Link>
        {isActive(run.status) && !run.machine.online && (
          <InfoMessage>
            <p>
              Machine {run.machine.name} is offline. The run goes on when it reconnects, or you can
              stop it.
            </p>
          </InfoMessage>
        )}
        <RunQuestion run={run} />
        <Card className="space-y-4">
          <p className="font-medium text-slate-900" aria-label="Run status">
            {runStateText(run)}
          </p>
          {run.endDetail && (run.status === 'failed' || run.status === 'cancelled') && (
            <p className="break-words whitespace-pre-wrap" aria-label="Why the run ended">
              {run.endDetail}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="text-slate-600">Purpose</dt>
            <dd>{purposeLabel[run.purpose]}</dd>
            <dt className="text-slate-600">Agent</dt>
            <dd>
              {run.profile.name} (version {run.profile.version})
            </dd>
            <dt className="text-slate-600">Machine</dt>
            <dd>
              <Link to={`/machines/${run.machine.id}`} className="text-blue-700 underline">
                {run.machine.name}
              </Link>
              {run.machine.online ? '' : ' (offline)'} · account {run.account.label}
            </dd>
            <dt className="text-slate-600">Time</dt>
            <dd>
              <RunTimes run={run} />
            </dd>
            <dt className="text-slate-600">Estimated usage</dt>
            <dd>{usageText(run.estimatedUsageUsd)}</dd>
            <dt className="text-slate-600">Started</dt>
            <dd>{formatDateTime(run.startedAt ?? run.createdAt)}</dd>
            {run.endedAt && (
              <>
                <dt className="text-slate-600">Ended</dt>
                <dd>{formatDateTime(run.endedAt)}</dd>
              </>
            )}
          </dl>
          {run.progress && (
            <div>
              <h2 className="font-medium text-slate-900">Latest progress</h2>
              <p className="break-words" aria-label="Progress">
                {run.progress.text}{' '}
                <span className="text-sm text-slate-600">({formatDateTime(run.progress.at)})</span>
              </p>
            </div>
          )}
          {run.outcome && (
            <div>
              <h2 className="font-medium text-slate-900">Outcome</h2>
              <p className="break-words whitespace-pre-wrap">{run.outcome}</p>
            </div>
          )}
          <RunActions run={run} />
        </Card>
        <CiWaitCard run={run} />
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-900">Branch</h2>
          <p className="break-words" aria-label="Branch">
            <code className="rounded bg-slate-100 px-1 text-sm">{run.branch.name}</code> on machine{' '}
            {run.machine.name}, as this run left it
          </p>
          {run.push && (
            <p className="break-words text-slate-700" aria-label="Push">
              {runPushText(run.push)}
            </p>
          )}
          {run.branch.head === null && isActive(run.status) ? (
            <p className="text-slate-700">The commits are shown when the run ends.</p>
          ) : (
            <CommitList commits={run.branch.commits} />
          )}
        </Card>
        <RefusedSubmission run={run} />
        <RunLog run={run} />
      </div>
    </>
  );
}

/** Run page (02, section 7): the run's facts and its live log. */
export function RunPage() {
  const { id = '' } = useParams();
  const run = useRun(id);
  if (run.isPending) return <Loading />;
  if (run.isError) {
    const missing = run.error instanceof ApiRequestError && run.error.code === 'run_not_found';
    return (
      <ErrorMessage>
        {missing ? 'This run does not exist.' : 'The run could not be loaded. Reload the page.'}
      </ErrorMessage>
    );
  }
  return <RunContent run={run.data} />;
}
