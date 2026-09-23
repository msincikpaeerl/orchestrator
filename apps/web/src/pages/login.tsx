import { SessionResponse } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  CenteredPage,
  ErrorMessage,
  HelpLink,
  Loading,
  TextField,
} from '../components/ui';
import { keys, queryClient, useSession, useSetupState } from '../queries';

function waitText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'invalid_credentials') return 'Wrong username or password.';
    if (error.code === 'too_many_attempts') {
      return `Too many failed attempts. Wait ${waitText(error.retryAfterSeconds ?? 60)} before trying again.`;
    }
  }
  return 'Logging in failed. Try again.';
}

/** Only addresses inside the application are followed after logging in. */
function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const setup = useSetupState();
  const session = useSession();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api('POST', '/api/auth/login', SessionResponse, { username, password }),
    onSuccess: (result) => {
      queryClient.setQueryData(keys.session, result);
    },
  });

  if (setup.isPending || session.isPending) return <Loading />;
  if (setup.data?.ownerCreated === false) return <Navigate to="/setup" replace />;
  if (session.data) return <Navigate to={safeNext(params.get('next'))} replace />;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <CenteredPage>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">Log in</h1>
        <HelpLink page="getting-started" newTab />
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <TextField
            label="Username"
            autoComplete="username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            required
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            required
          />
          {login.error && <ErrorMessage>{errorText(login.error)}</ErrorMessage>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="submit" disabled={login.isPending}>
              Log in
            </Button>
            <HelpLink page="reset-password" newTab>
              Forgot your password?
            </HelpLink>
          </div>
        </form>
      </Card>
    </CenteredPage>
  );
}
