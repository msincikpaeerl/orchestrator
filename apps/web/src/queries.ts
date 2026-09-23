import { GitHubStatusResponse, SessionResponse, SetupStateResponse } from '@orchestrator/protocol';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiRequestError, setUnauthenticatedHandler } from './api';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

export const keys = {
  setup: ['setup'],
  session: ['session'],
  github: ['github'],
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
