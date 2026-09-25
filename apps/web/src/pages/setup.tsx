import {
  PASSWORD_MIN_LENGTH,
  SessionResponse,
  type GitHubStatusResponse,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  CenteredPage,
  ErrorMessage,
  HelpLink,
  Loading,
  TextField,
  buttonLinkClass,
} from '../components/ui';
import { CreateTokenInstructions, PermissionResults, TokenForm } from '../github/token-form';
import { keys, queryClient, useSession, useSetupState } from '../queries';

function WizardStep({
  step,
  title,
  help,
  children,
}: {
  step: number;
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <CenteredPage>
      <p className="text-sm text-slate-600">Setup, step {step} of 2</p>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <HelpLink page={help} newTab />
      </div>
      <Card className="space-y-4">{children}</Card>
    </CenteredPage>
  );
}

/**
 * The setup wizard (02, section 3): shown until the account exists and GitHub is connected.
 * Help links open in a new tab so the form keeps what was typed.
 */
export function SetupPage() {
  const setup = useSetupState();
  const session = useSession();
  if (setup.isPending || session.isPending) return <Loading />;
  if (setup.isError) return <CenteredPage>The Orchestrator could not be reached.</CenteredPage>;
  if (!setup.data.ownerCreated) return <OwnerStep />;
  if (!session.data) return <Navigate to="/login" replace />;
  if (!setup.data.githubConnected) return <GitHubStep />;
  return <Navigate to="/" replace />;
}

function OwnerStep() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api('POST', '/api/setup/owner', SessionResponse, { username, password }),
    onSuccess: async (session) => {
      queryClient.setQueryData(keys.session, session);
      await queryClient.invalidateQueries({ queryKey: keys.setup });
    },
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setProblem(`The password needs at least ${String(PASSWORD_MIN_LENGTH)} characters.`);
    } else if (password !== repeat) {
      setProblem('The two passwords are different.');
    } else {
      setProblem(null);
      create.mutate();
    }
  }

  const error = create.error;
  return (
    <WizardStep step={1} title="Create your account" help="getting-started">
      <p>
        You are the only user of this Orchestrator. Choose the username and password you will log in
        with.
      </p>
      <form onSubmit={submit} className="space-y-4" noValidate>
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
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. A few unrelated words make a good password.`}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          required
        />
        <TextField
          label="Repeat the password"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(event) => {
            setRepeat(event.target.value);
          }}
          required
        />
        {problem && <ErrorMessage>{problem}</ErrorMessage>}
        {error && (
          <ErrorMessage>
            {error instanceof ApiRequestError && error.code === 'owner_exists' ? (
              <>
                The account already exists. <Link to="/login">Log in</Link>.
              </>
            ) : (
              'The account could not be created. Check the fields and try again.'
            )}
          </ErrorMessage>
        )}
        <Button type="submit" disabled={create.isPending || username.trim() === ''}>
          Create the account
        </Button>
      </form>
    </WizardStep>
  );
}

function GitHubStep() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<GitHubStatusResponse | null>(null);

  // The Done page refreshes the setup state: done here, the wizard would see GitHub connected
  // and send the owner to "Needs you" first.
  function finish() {
    void navigate('/setup/done');
  }

  if (saved?.connected) {
    const missing = saved.permissions.some((check) => check.result !== 'ok');
    return (
      <WizardStep step={2} title="Connect GitHub" help="github-token">
        <p>
          Token saved for the GitHub account <strong>{saved.account}</strong>.
        </p>
        <PermissionResults permissions={saved.permissions} />
        {missing && (
          <p className="text-slate-800">
            Some permissions are not confirmed. You can continue: &quot;Needs you&quot; will remind
            you, and you can replace the token later in Settings &gt; GitHub connection.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={finish}>Continue</Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSaved(null);
            }}
          >
            Enter another token
          </Button>
        </div>
      </WizardStep>
    );
  }

  return (
    <WizardStep step={2} title="Connect GitHub" help="github-token">
      <p>
        The Orchestrator uses a GitHub token to create repositories, push branches and open pull
        requests in your GitHub account. It never shows the token again once saved.
      </p>
      <CreateTokenInstructions newTabHelp />
      <TokenForm onSaved={setSaved} />
    </WizardStep>
  );
}

/** Last page of the wizard (02, section 3, step 5). */
export function SetupDonePage() {
  const session = useSession();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: keys.setup });
  }, []);
  if (session.isPending) return <Loading />;
  if (!session.data) return <Navigate to="/login" replace />;
  return (
    <CenteredPage>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">Setup done</h1>
      <Card className="space-y-4">
        <p>
          Your account is created and GitHub is connected. Next, add your Claude account and the
          computer where agents will work, in Machines: &quot;Needs you&quot; reminds you, and tells
          you whenever something needs your attention.
        </p>
        <p>
          The Help section explains everything the Orchestrator does, starting with the{' '}
          <Link to="/help/getting-started" className="text-blue-700 underline">
            getting started guide
          </Link>
          .
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/help" className={buttonLinkClass}>
            Open Help
          </Link>
          <Link
            to="/"
            className="inline-block rounded border border-slate-300 px-4 py-2 font-medium text-slate-800"
          >
            Go to Needs you
          </Link>
        </div>
      </Card>
    </CenteredPage>
  );
}
