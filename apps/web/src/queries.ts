import {
  AccountListResponse,
  AgentListResponse,
  EventListResponse,
  GitHubStatusResponse,
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
  TicketListResponse,
  UiSettingsResponse,
} from '@orchestrator/protocol';
import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiRequestError, setUnauthenticatedHandler } from './api';

// Screens refresh after each action and when the window regains focus (02, section 1).
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

export const keys = {
  setup: ['setup'],
  session: ['session'],
  github: ['github'],
  needsYou: ['needs-you'],
  uiSettings: ['ui-settings'],
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

export function useUiSettings() {
  return useQuery({
    queryKey: keys.uiSettings,
    queryFn: () => api('GET', '/api/ui-settings', UiSettingsResponse),
    staleTime: Infinity,
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
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.uiSettings }),
    queryClient.invalidateQueries({ queryKey: ['projects', 'settings'] }),
  ]);
}

export function useProjects(archived: boolean) {
  return useQuery({
    queryKey: keys.projectList(archived),
    queryFn: () =>
      api('GET', `/api/projects${archived ? '?archived=true' : ''}`, ProjectListResponse),
  });
}

/**
 * One project. While its repository setup runs, it is asked for again at the interval of the
 * `projectSetupPollSeconds` setting, and no longer once the setup is ready or failed.
 */
export function useProject(key: string) {
  const settings = useUiSettings();
  const interval = (settings.data?.projectSetupPollSeconds ?? 0) * 1000;
  return useQuery({
    queryKey: keys.project(key),
    queryFn: () => api('GET', `/api/projects/${encodeURIComponent(key)}`, Project),
    refetchInterval: (query) =>
      interval > 0 && query.state.data?.setup.status === 'in_progress' ? interval : false,
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
  await queryClient.invalidateQueries({ queryKey: keys.projects });
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
 * One machine. Read again when the window regains focus, so a machine being added shows its
 * connection once the owner comes back from the terminal (the realtime stream comes later).
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
