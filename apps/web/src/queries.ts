import {
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
  SessionResponse,
  SetupStateResponse,
  TicketDetail,
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
  machines: ['machines'],
  machine: (id: string) => ['machines', id] as const,
  agents: ['agents'],
  runs: ['runs'],
  run: (id: string) => ['runs', id] as const,
  liveRuns: ['runs', 'live'],
  liveRunsOf: (machine: string) => ['runs', 'live', machine] as const,
  runHistory: (query: string) => ['runs', 'history', query] as const,
  ticketRuns: (key: string, number: number) => ['runs', 'ticket', key, number] as const,
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

export function useTicket(projectKey: string, number: number) {
  return useQuery({
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
