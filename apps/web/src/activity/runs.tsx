import { RunEndState, type LiveRun, type Run } from '@orchestrator/protocol';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, ErrorMessage, Loading, SelectField, TextField } from '../components/ui';
import { formatDateTime } from '../github/text';
import { Command } from '../machines/command';
import { useAgents, useLiveRuns, useProjects, useRunHistory } from '../queries';
import { refusalText } from '../refusals';
import { LogEntry, RunActions, RunTimes } from '../runs/components';
import { runPath, runStateText, usageText } from '../runs/text';
import { ticketPath } from '../tickets/text';
import { dayStart } from './days';

/** The ticket's number in `WEB-12`. */
function ticketNumber(run: Run): number {
  return Number(run.ticket.slice(run.projectKey.length + 1));
}

/** The command attaching a terminal to the run's session, read-only (05, section 8). */
export function attachCommand(run: Pick<Run, 'id'>): string {
  return `orchestrator-daemon attach ${run.id}`;
}

/**
 * One active run: what the agent is doing now, with its latest log entry, updated live, and a link
 * to the full log (owner's decision, lot 2 step L2).
 */
export function LiveRunCard({ run }: { run: LiveRun }) {
  return (
    <Card className="space-y-3">
      <div className="space-y-1">
        <h3 className="font-semibold break-words text-slate-900">
          <Link
            to={ticketPath(run.projectKey, ticketNumber(run))}
            className="text-blue-700 underline"
          >
            {run.ticket}
          </Link>{' '}
          · {run.profile.name} on {run.machine.name}
        </h3>
        <p className="text-slate-800" aria-label="Run status">
          {runStateText(run)}
        </p>
        <p className="text-sm text-slate-600">
          <RunTimes run={run} /> · usage {usageText(run.estimatedUsageUsd)}
        </p>
      </div>
      {run.progress && <p className="break-words text-slate-800">{run.progress.text}</p>}
      <div>
        <p className="text-sm font-medium text-slate-700">Now</p>
        {run.latestLog === null ? (
          <p className="text-slate-700">Nothing in its log yet.</p>
        ) : (
          <ol aria-label="Latest log entry" className="max-h-40 overflow-hidden">
            <LogEntry entry={run.latestLog} />
          </ol>
        )}
        <Link to={runPath(run.id)} className="mt-1 inline-block text-blue-700 underline">
          Open the run and its full log
        </Link>
      </div>
      <RunActions run={run} />
      <details>
        <summary className="cursor-pointer text-blue-700">Watch it in a terminal</summary>
        <p className="mt-2 text-sm text-slate-700">
          On machine {run.machine.name}, this command shows the agent's session without letting you
          type in it.
        </p>
        <Command command={attachCommand(run)} label="Attach command" />
      </details>
    </Card>
  );
}

/** Activity > Live runs (02, section 7): every active run, waiting and paused ones marked. */
export function LiveRuns() {
  const live = useLiveRuns();
  return (
    <section aria-labelledby="live-runs-title" className="space-y-4">
      <h2 id="live-runs-title" className="text-xl font-semibold text-slate-900">
        Live runs
      </h2>
      {live.isPending ? (
        <Loading />
      ) : live.isError ? (
        <ErrorMessage>{refusalText(live.error)}</ErrorMessage>
      ) : live.data.runs.length === 0 ? (
        <Card>
          <p>No run is active. Start one with Run now on a ticket.</p>
        </Card>
      ) : (
        <ul aria-label="Live runs" className="space-y-3">
          {live.data.runs.map((run) => (
            <li key={run.id}>
              <LiveRunCard run={run} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const outcomeLabel: Record<RunEndState, string> = {
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** History's filters in the address, apart from the event log's. */
const FILTERS = {
  project: 'runProject',
  agent: 'runAgent',
  outcome: 'runOutcome',
  from: 'runFrom',
  to: 'runTo',
} as const;
type Filter = keyof typeof FILTERS;

/** The API query of the filters: the last day chosen is included. */
function apiQuery(params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const name of ['project', 'agent', 'outcome'] as const) {
    const value = params.get(FILTERS[name]);
    if (value) query.set(name, value);
  }
  const from = dayStart(params.get(FILTERS.from) ?? '');
  if (from) query.set('from', from);
  const to = dayStart(params.get(FILTERS.to) ?? '', 1);
  if (to) query.set('to', to);
  return query.toString();
}

function HistoryItem({ run }: { run: Run }) {
  return (
    <li className="space-y-1 border-b border-slate-200 py-3 last:border-b-0">
      <p className="break-words text-slate-900">
        <Link to={runPath(run.id)} className="text-blue-700 underline">
          {run.ticket} · attempt {run.attempt}
        </Link>{' '}
        · {run.profile.name} on {run.machine.name}
      </p>
      {/* The failure reason of a failed run is part of its state (owner's decision, L2). */}
      <p className="text-slate-800">{runStateText(run)}</p>
      <p className="text-sm text-slate-600">
        Ended {run.endedAt ? formatDateTime(run.endedAt) : '—'} · <RunTimes run={run} /> · usage{' '}
        {usageText(run.estimatedUsageUsd)}
      </p>
    </li>
  );
}

/** Activity > History (02, section 7): ended runs with filters, a page at a time. */
export function RunHistory() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects(true);
  const agents = useAgents();
  const history = useRunHistory(apiQuery(params));
  const value = (name: Filter) => params.get(FILTERS[name]) ?? '';
  const set = (name: Filter, next: string) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === '') updated.delete(FILTERS[name]);
        else updated.set(FILTERS[name], next);
        return updated;
      },
      { replace: true },
    );
  };
  const filtered = Object.values(FILTERS).some((name) => params.has(name));
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <section aria-labelledby="history-title" className="space-y-4">
      <h2 id="history-title" className="text-xl font-semibold text-slate-900">
        History
      </h2>
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Project"
            value={value('project')}
            onChange={(event) => {
              set('project', event.target.value);
            }}
          >
            <option value="">All projects</option>
            {projects.data?.projects.map((project) => (
              <option key={project.key} value={project.key}>
                {project.key} · {project.name}
                {project.status === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Agent"
            value={value('agent')}
            onChange={(event) => {
              set('agent', event.target.value);
            }}
          >
            <option value="">All agents</option>
            {agents.data?.agents.map((agent) => (
              <option key={agent.key} value={agent.key}>
                {agent.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Outcome"
            value={value('outcome')}
            onChange={(event) => {
              set('outcome', event.target.value);
            }}
          >
            <option value="">Every outcome</option>
            {RunEndState.options.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeLabel[outcome]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Ended from"
            type="date"
            value={value('from')}
            onChange={(event) => {
              set('from', event.target.value);
            }}
          />
          <TextField
            label="Ended to"
            type="date"
            value={value('to')}
            onChange={(event) => {
              set('to', event.target.value);
            }}
          />
        </div>
        {filtered && (
          <Button
            variant="secondary"
            onClick={() => {
              setParams(
                (current) => {
                  const updated = new URLSearchParams(current);
                  for (const name of Object.values(FILTERS)) updated.delete(name);
                  return updated;
                },
                { replace: true },
              );
            }}
          >
            Clear run filters
          </Button>
        )}
      </Card>
      {history.isPending ? (
        <Loading />
      ) : history.isError ? (
        <ErrorMessage>{refusalText(history.error)}</ErrorMessage>
      ) : runs.length === 0 ? (
        <Card>
          <p>{filtered ? 'No run matches these filters.' : 'No run has ended yet.'}</p>
        </Card>
      ) : (
        <Card>
          <ul aria-label="Ended runs">
            {runs.map((run) => (
              <HistoryItem key={run.id} run={run} />
            ))}
          </ul>
          {history.hasNextPage && (
            <Button
              variant="secondary"
              className="mt-4"
              disabled={history.isFetchingNextPage}
              onClick={() => {
                void history.fetchNextPage();
              }}
            >
              {history.isFetchingNextPage ? 'Loading…' : 'Show older runs'}
            </Button>
          )}
        </Card>
      )}
    </section>
  );
}
