import { EventEntityType, EventType, type EventLogEntry } from '@orchestrator/protocol';
import { useSearchParams } from 'react-router';
import { EventText } from '../activity/event-text';
import { actorLabel, entityLabel, eventTypeLabel } from '../activity/text';
import {
  Button,
  Card,
  ErrorMessage,
  Loading,
  PageHeader,
  SelectField,
  TextField,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { useEventLog, useProjects } from '../queries';
import { refusalText } from '../refusals';

/** The filters kept in the address, so a filtered log can be reloaded or shared. */
const FILTERS = ['project', 'ticket', 'entity', 'type', 'from', 'to'] as const;
type Filter = (typeof FILTERS)[number];

/** Start of a day chosen in the owner's time zone (`2026-09-24`), plus `days`. */
function dayStart(date: string, days = 0): string | null {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days).toISOString();
}

/** The API query of the filters: the last day chosen is included. */
function apiQuery(params: URLSearchParams): string {
  const query = new URLSearchParams();
  const project = params.get('project');
  if (project) {
    query.set('project', project);
    const ticket = params.get('ticket')?.trim();
    if (ticket) query.set('ticket', ticket);
  }
  for (const name of ['entity', 'type'] as const) {
    const value = params.get(name);
    if (value) query.set(name, value);
  }
  const from = dayStart(params.get('from') ?? '');
  if (from) query.set('from', from);
  const to = dayStart(params.get('to') ?? '', 1);
  if (to) query.set('to', to);
  return query.toString();
}

function EventItem({ entry }: { entry: EventLogEntry }) {
  return (
    <li className="border-b border-slate-200 py-3 last:border-b-0">
      <p className="break-words text-slate-900">
        <EventText entry={entry} />
      </p>
      <p className="text-sm text-slate-600">
        {formatDateTime(entry.at)} · {actorLabel[entry.actor]}
      </p>
    </li>
  );
}

function EventLog() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects(true);
  const log = useEventLog(apiQuery(params));
  const value = (name: Filter) => params.get(name) ?? '';
  const set = (name: Filter, next: string) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === '') updated.delete(name);
        else updated.set(name, next);
        if (name === 'project' && next === '') updated.delete('ticket');
        return updated;
      },
      { replace: true },
    );
  };
  const filtered = FILTERS.some((name) => params.has(name));
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section aria-labelledby="event-log-title" className="space-y-4">
      <h2 id="event-log-title" className="text-xl font-semibold text-slate-900">
        Event log
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
            <option value="">All projects, and events about no project</option>
            {projects.data?.projects.map((project) => (
              <option key={project.key} value={project.key}>
                {project.key} · {project.name}
                {project.status === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Ticket number"
            hint={value('project') ? undefined : 'Choose a project first.'}
            inputMode="numeric"
            disabled={!value('project')}
            value={value('ticket')}
            onChange={(event) => {
              set('ticket', event.target.value.replace(/\D/g, ''));
            }}
          />
          <SelectField
            label="Kind"
            value={value('entity')}
            onChange={(event) => {
              set('entity', event.target.value);
            }}
          >
            <option value="">Everything</option>
            {EventEntityType.options.map((entity) => (
              <option key={entity} value={entity}>
                {entityLabel[entity]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Event"
            value={value('type')}
            onChange={(event) => {
              set('type', event.target.value);
            }}
          >
            <option value="">Every event</option>
            {EventType.options.map((type) => (
              <option key={type} value={type}>
                {eventTypeLabel[type]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="From"
            type="date"
            value={value('from')}
            onChange={(event) => {
              set('from', event.target.value);
            }}
          />
          <TextField
            label="To"
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
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
      </Card>
      {log.isPending ? (
        <Loading />
      ) : log.isError ? (
        <ErrorMessage>{refusalText(log.error)}</ErrorMessage>
      ) : events.length === 0 ? (
        <Card>
          <p>{filtered ? 'No event matches these filters.' : 'No event yet.'}</p>
        </Card>
      ) : (
        <Card>
          <ul aria-label="Events">
            {events.map((entry) => (
              <EventItem key={entry.id} entry={entry} />
            ))}
          </ul>
          {log.hasNextPage && (
            <Button
              variant="secondary"
              className="mt-4"
              disabled={log.isFetchingNextPage}
              onClick={() => {
                void log.fetchNextPage();
              }}
            >
              {log.isFetchingNextPage ? 'Loading…' : 'Show older events'}
            </Button>
          )}
        </Card>
      )}
    </section>
  );
}

/** Activity (02, section 7): the event log; runs come with later versions. */
export function ActivityPage() {
  return (
    <>
      <PageHeader title="Activity" help="activity" />
      <div className="space-y-6">
        <Card>
          <p className="font-medium">Live runs, queue and run history</p>
          <p className="mt-2 text-slate-700">Coming in a later version.</p>
        </Card>
        <EventLog />
      </div>
    </>
  );
}
