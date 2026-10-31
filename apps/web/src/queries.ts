import {
  AccountDetailResponse,
  AccountListResponse,
  AgentListResponse,
  EventListResponse,
  GitHubStatusResponse,
  LiveRunsResponse,
  RunHistoryResponse,
  GlobalSettingsResponse,
  Machine,
  MachineListResponse,
  NeedsYouResponse,
  Project,
  ProjectListResponse,
  ProjectSettingsResponse,
  QueueResponse,
  RequestDetail,
  RequestListResponse,
  SessionResponse,
  SetupStateResponse,
  TicketDetail,
  TimeZoneResponse,
  RunDetail,
  RunListResponse,
  TicketListResponse,
} from '@orchestrator/protocol';
import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiRequestError, setUnauthenticatedHandler } from './api';

// Screens refresh after each action, when the window regains focus, and on the realtime
// stream's messages (02, section 1; `live.ts`).
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

/**
 * Today's working time, usage and window position move with the clock and with each run's
 * estimate, which writes no event: the account screens read them again every minute.
 */
const ACCOUNT_REFRESH_MS = 60_000;

export const keys = {
  setup: ['setup'],
  session: ['session'],
  github: ['github'],
  needsYou: ['needs-you'],
  settings: ['settings'],
  projects: ['projects'],
  projectList: (archived: boolean) => ['projects', 'list', archived] as const,
  project: (key: string) => ['projects', 'detail', key] as const,
  projectSettings: (key: string) => ['projects', 'settings', key] as const,
  tickets: (key: string) => ['projects', 'tickets', key] as const,
  ticket: (key: string, number: number) => ['projects', 'tickets', key, number] as const,
  events: (query: string) => ['events', query] as const,
  accounts: ['accounts'],
  account: (id: string) => ['accounts', id] as const,
  timeZone: ['time-zone'],
  machines: ['machines'],
  machine: (id: string) => ['machines', id] as const,
  agents: ['agents'],
  runs: ['runs'],
  run: (id: string) => ['runs', id] as const,
  liveRuns: ['runs', 'live'],
  liveRunsOf: (machine: string) => ['runs', 'live', machine] as const,
  runHistory: (query: string) => ['runs', 'history', query] as const,
  ticketRuns: (key: string, number: number) => ['runs', 'ticket', key, number] as const,
  queue: ['queue'],
  requests: ['requests'],
  request: (number: number) => ['requests', number] as const,
} as const;

setUnauthenticatedHandler(() => {
  queryClient.setQueryData(keys.session, null);
});

export function useSetupState() {
  return useQuery({
    queryKey: keys.setup,
    queryFn: () => api('GET', '/api/setup', SetupStateResponse),
  });
}

/** The logged-in session, or `null` when logged out. */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => {
      try {
        return await api('GET', '/api/auth/session', SessionResponse);
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'not_authenticated') return null;
        throw error;
      }
    },
  });
}

export function useGitHubStatus(enabled = true) {
  return useQuery({
    queryKey: keys.github,
    queryFn: () => api('GET', '/api/github', GitHubStatusResponse),
    enabled,
  });
}

/** "Needs you" items besides the GitHub problems (02, section 4), for the page and the menu's count. */
export function useNeedsYou() {
  return useQuery({
    queryKey: keys.needsYou,
    queryFn: () => api('GET', '/api/needs-you', NeedsYouResponse),
    // The accounts' windows and daily budgets move with the clock (lot 4 step C).
    refetchInterval: ACCOUNT_REFRESH_MS,
  });
}

/** Settings > Limits: every setting with its global value. */
export function useGlobalSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api('GET', '/api/settings', GlobalSettingsResponse),
  });
}

/** The settings a project can override, with its overrides and the global values. */
export function useProjectSettings(projectKey: string) {
  return useQuery({
    queryKey: keys.projectSettings(projectKey),
    queryFn: () =>
      api(
        'GET',
        `/api/projects/${encodeURIComponent(projectKey)}/settings`,
        ProjectSettingsResponse,
      ),
  });
}

/**
 * After a change of a global value: the settings the screens use and every project's overrides
 * (they show the global value) are read again.
 */
export async function settingsChanged(settings: GlobalSettingsResponse) {
  queryClient.setQueryData(keys.settings, settings);
  await queryClient.invalidateQueries({ queryKey: ['projects', 'settings'] });
}

export function useProjects(archived: boolean) {
  return useQuery({
    queryKey: keys.projectList(archived),
    queryFn: () =>
      api('GET', `/api/projects${archived ? '?archived=true' : ''}`, ProjectListResponse),
  });
}

/** One project; its repository setup's progress comes with the realtime stream. */
export function useProject(key: string) {
  return useQuery({
    queryKey: keys.project(key),
    queryFn: () => api('GET', `/api/projects/${encodeURIComponent(key)}`, Project),
  });
}

/** After an action on projects: every project screen and "Needs you" are read again. */
export async function projectsChanged(project?: Project) {
  if (project) queryClient.setQueryData(keys.project(project.key), project);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.projects }),
    queryClient.invalidateQueries({ queryKey: keys.needsYou }),
  ]);
}

/** The agent profiles, for a ticket's assignee. */
export function useAgents() {
  return useQuery({
    queryKey: keys.agents,
    queryFn: () => api('GET', '/api/agents', AgentListResponse),
  });
}

export function useTickets(projectKey: string, enabled = true) {
  return useQuery({
    queryKey: keys.tickets(projectKey),
    queryFn: () =>
      api('GET', `/api/projects/${encodeURIComponent(projectKey)}/tickets`, TicketListResponse),
    enabled,
  });
}

export function useTicket(projectKey: string, number: number, enabled = true) {
  return useQuery({
    enabled,
    queryKey: keys.ticket(projectKey, number),
    queryFn: () =>
      api(
        'GET',
        `/api/projects/${encodeURIComponent(projectKey)}/tickets/${String(number)}`,
        TicketDetail,
      ),
  });
}

/**
 * After an action on a ticket, or a refusal of one: the ticket, the board, the other tickets
 * (their dependency lists) and the project list's counts are read again.
 */
export async function ticketsChanged(ticket?: TicketDetail) {
  if (ticket) queryClient.setQueryData(keys.ticket(ticket.projectKey, ticket.number), ticket);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.projects }),
    queryClient.invalidateQueries({ queryKey: keys.runs }),
    queryClient.invalidateQueries({ queryKey: keys.needsYou }),
  ]);
}

/** Every request, newest first (02, section 5.1). */
export function useRequests() {
  return useQuery({
    queryKey: keys.requests,
    queryFn: () => api('GET', '/api/requests', RequestListResponse),
  });
}

export function useRequest(number: number) {
  return useQuery({
    queryKey: keys.request(number),
    queryFn: () => api('GET', `/api/requests/${String(number)}`, RequestDetail),
  });
}

/** After an action on a request: the request, the list and Needs you are read again. */
export async function requestsChanged(request?: RequestDetail) {
  if (request) queryClient.setQueryData(keys.request(request.number), request);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.requests }),
    queryClient.invalidateQueries({ queryKey: keys.needsYou }),
  ]);
}

/** A ticket's runs, newest first (02, section 6.4). */
export function useTicketRuns(projectKey: string, number: number) {
  return useQuery({
    queryKey: keys.ticketRuns(projectKey, number),
    queryFn: () =>
      api(
        'GET',
        `/api/projects/${encodeURIComponent(projectKey)}/tickets/${String(number)}/runs`,
        RunListResponse,
      ),
  });
}

/** One run (02, section 7). */
export function useRun(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.run(id),
    queryFn: () => api('GET', `/api/runs/${encodeURIComponent(id)}`, RunDetail),
    enabled: enabled && id !== '',
  });
}

/**
 * Activity > Live runs (02, section 7): every active run with its latest log entry; with
 * `machine`, that machine's runs only (02, section 9.2).
 */
export function useLiveRuns(machine?: string) {
  return useQuery({
    queryKey: machine === undefined ? keys.liveRuns : keys.liveRunsOf(machine),
    queryFn: () =>
      api(
        'GET',
        `/api/runs/live${machine === undefined ? '' : `?machine=${encodeURIComponent(machine)}`}`,
        LiveRunsResponse,
      ),
  });
}

/** Activity > History: ended runs matching `query`, newest first, a page at a time. */
export function useRunHistory(query: string) {
  return useInfiniteQuery({
    queryKey: keys.runHistory(query),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query);
      if (pageParam !== null) params.set('before', pageParam);
      const search = params.toString();
      return api('GET', `/api/runs/history${search ? `?${search}` : ''}`, RunHistoryResponse);
    },
    getNextPageParam: (last) => last.next,
  });
}

/**
 * Activity > Event log: the events matching `query` (the filters as URL parameters), newest
 * first. Each further page starts at the cursor of the previous one.
 */
export function useEventLog(query: string) {
  return useInfiniteQuery({
    queryKey: keys.events(query),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query);
      if (pageParam !== null) params.set('before', pageParam);
      const search = params.toString();
      return api('GET', `/api/events${search ? `?${search}` : ''}`, EventListResponse);
    },
    getNextPageParam: (last) => last.next,
  });
}

/** Claude accounts, by label (02, section 9.1). */
export function useAccounts() {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: () => api('GET', '/api/accounts', AccountListResponse),
  });
}

/**
 * Activity > Queue (02, section 7; lot 4 step H): read again on every change the stream reports
 * that can move it (`live.ts`), and at the next time it names (a window opening, a limit or a
 * suspected limit's wait ending, the day's end), at least once a minute: windows and budgets move
 * with the clock without an event. Reading it starts nothing.
 */
export function useQueue() {
  return useQuery({
    queryKey: keys.queue,
    queryFn: () => api('GET', '/api/queue', QueueResponse),
    refetchInterval: (query) =>
      query.state.data ? queueRefreshMs(query.state.data, Date.now()) : ACCOUNT_REFRESH_MS,
  });
}

/**
 * When to read the queue again: just after the soonest time it names that is still to come, or
 * after a minute when that is later (lot 4 step H).
 */
export function queueRefreshMs(queue: QueueResponse, now: number): number {
  let next = ACCOUNT_REFRESH_MS;
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      const at = ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
      if (at > now) next = Math.min(next, at - now + QUEUE_REFRESH_DELAY_MS);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
  };
  visit(queue);
  return next;
}

/** An ISO time in an API answer (`z.iso.datetime()`). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The queue is read again this long after a time it names, so the server sees that time passed. */
const QUEUE_REFRESH_DELAY_MS = 1000;

/** Claude accounts with their day so far, for Machines (lot 4 step C). */
export function useAccountsLive() {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: () => api('GET', '/api/accounts', AccountListResponse),
    refetchInterval: ACCOUNT_REFRESH_MS,
  });
}

/** One account's page: its days and limits reached (02, section 9.1). */
export function useAccount(id: string) {
  return useQuery({
    queryKey: keys.account(id),
    queryFn: () => api('GET', `/api/accounts/${encodeURIComponent(id)}`, AccountDetailResponse),
    refetchInterval: ACCOUNT_REFRESH_MS,
  });
}

/** The Orchestrator's time zone (02, section 10). */
export function useTimeZone() {
  return useQuery({
    queryKey: keys.timeZone,
    queryFn: () => api('GET', '/api/time-zone', TimeZoneResponse),
  });
}

/** Machines, by name (02, section 9.2). */
export function useMachines() {
  return useQuery({
    queryKey: keys.machines,
    queryFn: () => api('GET', '/api/machines', MachineListResponse),
  });
}

/**
 * One machine. A machine being added shows its connection through the realtime stream, and again
 * when the window regains focus.
 */
export function useMachine(id: string) {
  return useQuery({
    queryKey: keys.machine(id),
    queryFn: () => api('GET', `/api/machines/${encodeURIComponent(id)}`, Machine),
  });
}

/**
 * After an action on accounts or machines: both lists, every machine (they show their account's
 * label) and "Needs you" are read again.
 */
export async function machinesChanged(machine?: Machine) {
  if (machine) queryClient.setQueryData(keys.machine(machine.id), machine);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.accounts }),
    queryClient.invalidateQueries({ queryKey: keys.machines }),
    queryClient.invalidateQueries({ queryKey: keys.needsYou }),
  ]);
}
