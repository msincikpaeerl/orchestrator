import {
  EnrollmentResponse,
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SessionResponse,
  type ClaudeAccount,
  type CreateMachineRequest,
  type Enrollment,
  type GitHubStatusResponse,
  type Machine,
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
  SelectField,
  TextField,
  buttonLinkClass,
  secondaryButtonLinkClass,
} from '../components/ui';
import { CreateTokenInstructions, PermissionResults, TokenForm } from '../github/token-form';
import { useLiveStream } from '../live';
import { AccountForm } from '../machines/account-form';
import { BudgetEditor, ScheduleEditor } from '../machines/account-parts';
import { ConnectionStatus, EnrollmentSteps, NewEnrollmentCode } from '../machines/enrollment';
import { budgetText, scheduleText } from '../machines/schedule-text';
import {
  keys,
  machinesChanged,
  queryClient,
  useAccount,
  useAccounts,
  useMachines,
  useSession,
  useSetupState,
} from '../queries';
import { refusalText } from '../refusals';
import { TimeZoneNote } from './account';
import { PlainHttpWarning } from './add-machine';

/** Steps of a fresh install's wizard; an install from before 0.6.0 has only the first two. */
const FRESH_STEPS = 4;

function WizardStep({
  step,
  total = FRESH_STEPS,
  title,
  help,
  children,
}: {
  step: number;
  total?: number;
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <CenteredPage>
      <p className="text-sm text-slate-600">
        Setup, step {step} of {total}
      </p>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <HelpLink page={help} newTab />
      </div>
      <Card className="space-y-4">{children}</Card>
    </CenteredPage>
  );
}

/**
 * The setup wizard (02, section 3): shown until the account exists, GitHub is connected and, on a
 * fresh install, steps 3 and 4 (a Claude account, a machine) are left (lot 5 step J; an owner
 * created before 0.6.0 is never sent through them). Help links open in a new tab so the form
 * keeps what was typed.
 */
export function SetupPage() {
  const setup = useSetupState();
  const session = useSession();
  if (setup.isPending || session.isPending) return <Loading />;
  if (setup.isError) return <CenteredPage>The Orchestrator could not be reached.</CenteredPage>;
  if (!setup.data.ownerCreated) return <OwnerStep />;
  if (!session.data) return <Navigate to="/login" replace />;
  const fresh = !setup.data.setupFinished;
  if (!setup.data.githubConnected) return <GitHubStep fresh={fresh} />;
  if (fresh) return <ClaudeSteps />;
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

function GitHubStep({ fresh }: { fresh: boolean }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<GitHubStatusResponse | null>(null);
  const total = fresh ? FRESH_STEPS : 2;

  // A fresh install goes on to step 3 once the setup state says GitHub is connected. Before
  // 0.6.0's steps, the Done page refreshes the setup state: done here, the wizard would see
  // GitHub connected and send the owner to "Needs you" first.
  function finish() {
    if (fresh) void queryClient.invalidateQueries({ queryKey: keys.setup });
    else void navigate('/setup/done');
  }

  if (saved?.connected) {
    const missing = saved.permissions.some((check) => check.result !== 'ok');
    return (
      <WizardStep step={2} total={total} title="Connect GitHub" help="github-token">
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
    <WizardStep step={2} total={total} title="Connect GitHub" help="github-token">
      <p>
        The Orchestrator uses a GitHub token to create repositories, push branches and open pull
        requests in your GitHub account. It never shows the token again once saved.
      </p>
      <CreateTokenInstructions newTabHelp />
      <TokenForm onSaved={setSaved} />
    </WizardStep>
  );
}

/**
 * Steps 3 and 4 of a fresh install (lot 5 step J). The wizard resumes where the owner was: step 3
 * while no Claude account exists, step 4 otherwise. Once shown, step 3 stays until its
 * **Continue**, although the account it adds already exists. The realtime stream shows the
 * machine connecting.
 */
function ClaudeSteps() {
  useLiveStream(true);
  const accounts = useAccounts();
  const [step, setStep] = useState<3 | 4 | null>(null);
  if (accounts.isPending) return <Loading />;
  if (accounts.isError) {
    return <CenteredPage>The Claude accounts could not be loaded. Reload the page.</CenteredPage>;
  }
  const list = accounts.data.accounts;
  if (step === null && list.length === 0) setStep(3);
  if ((step ?? (list.length === 0 ? 3 : 4)) === 3) {
    return (
      <AccountStep
        onContinue={() => {
          setStep(4);
        }}
      />
    );
  }
  return <MachineStep accounts={list} />;
}

function AccountStep({ onContinue }: { onContinue: () => void }) {
  const [savedId, setSavedId] = useState<string | null>(null);
  return (
    <WizardStep step={3} title="Add your Claude account" help="machines#add-a-claude-account">
      {savedId === null ? (
        <>
          <p>
            Agents work with your Claude subscription. Name the account you will log into on your
            machines, and choose its plan.
          </p>
          <AccountForm
            cancel={false}
            onDone={(saved) => {
              if (saved) setSavedId(saved.id);
            }}
          />
        </>
      ) : (
        <AccountLimits id={savedId} onContinue={onContinue} />
      )}
    </WizardStep>
  );
}

/** Step 3 once the account is added: its optional windows and budget, then **Continue**. */
function AccountLimits({ id, onContinue }: { id: string; onContinue: () => void }) {
  const detail = useAccount(id);
  if (detail.isPending) return <Loading />;
  if (detail.isError) {
    return <ErrorMessage>The account could not be loaded. Reload the page.</ErrorMessage>;
  }
  const { account, timeZone } = detail.data;
  return (
    <>
      <p role="status" className="font-medium text-green-900">
        Account {account.label} added.
      </p>
      <p>
        If you also use Claude yourself, you can keep part of your usage for you: agents start runs
        only within the windows, and stop starting them once the daily budget is used. Both are
        optional, and you can change them later in Machines.
      </p>
      <TimeZoneNote timeZone={timeZone} />
      <section className="space-y-3" aria-labelledby="wizard-windows">
        <h2 id="wizard-windows" className="text-lg font-semibold text-slate-900">
          Schedule windows
        </h2>
        <p className="text-slate-900">{scheduleText(account.schedule)}</p>
        <ScheduleEditor
          key={JSON.stringify(account.schedule)}
          account={account}
          timeZone={timeZone.timeZone}
        />
      </section>
      <section className="space-y-3" aria-labelledby="wizard-budget">
        <h2 id="wizard-budget" className="text-lg font-semibold text-slate-900">
          Daily budget
        </h2>
        <p className="text-slate-900">{budgetText(account.dailyBudget)}</p>
        <BudgetEditor
          key={JSON.stringify(account.dailyBudget)}
          account={account}
          timeZone={timeZone.timeZone}
        />
      </section>
      <div>
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </>
  );
}

/** A machine that can receive runs: connected, enabled, every check passed. */
function isReady(machine: Machine): boolean {
  return machine.online && machine.state !== 'disabled' && machine.unusable.length === 0;
}

/**
 * Step 4: a machine. The form, then the commands and the connection of **Add machine**; after a
 * reload, the machine already added, with **New enrollment code** while it has not enrolled
 * (the code is shown only once). **Continue** once the machine is ready; **Skip for now** always.
 */
function MachineStep({ accounts }: { accounts: ClaudeAccount[] }) {
  const navigate = useNavigate();
  const machines = useMachines();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  // The machine just added, until the list read again includes it.
  const [created, setCreated] = useState<Machine | null>(null);
  const finish = useMutation({
    mutationFn: () => api('POST', '/api/setup/finish', null),
    onSuccess: () => {
      void navigate('/setup/done');
    },
  });

  if (machines.isPending) return <Loading />;
  if (machines.isError) {
    return <CenteredPage>The machines could not be loaded. Reload the page.</CenteredPage>;
  }
  const machine =
    machines.data.machines.find((candidate) => candidate.state !== 'revoked') ?? created;
  const waiting = machine?.state === 'waiting_enrollment';
  const expired = enrollment !== null && waiting && new Date(enrollment.expiresAt) <= new Date();

  return (
    <WizardStep step={4} title="Add a machine" help="machines#add-a-machine">
      {!machine ? (
        <>
          <p>
            Agents work on a computer of yours, in Ubuntu on Windows or on Linux, with the
            Orchestrator&apos;s daemon installed. Name it, then type the commands this page shows in
            its terminal.
          </p>
          <PlainHttpWarning />
          <MachineForm
            accounts={accounts}
            onCreated={(result) => {
              setEnrollment(result.enrollment);
              setCreated(result.machine);
            }}
          />
        </>
      ) : enrollment && !expired ? (
        <EnrollmentSteps enrollment={enrollment} machine={machine} links={false} />
      ) : waiting ? (
        <NewEnrollmentCode machine={machine} onIssued={setEnrollment} />
      ) : (
        <section className="space-y-2" aria-label={`Connect ${machine.name}`}>
          <h2 className="text-lg font-semibold text-slate-900">Connect {machine.name}</h2>
          <ConnectionStatus machine={machine} links={false} />
        </section>
      )}
      {machine && !isReady(machine) && (
        <p className="text-sm text-slate-700">
          Not ready yet? Click <strong>Skip for now</strong>: &quot;Needs you&quot; shows &quot;No
          machine enrolled yet&quot; until a machine enrolls, and Machines shows its commands again.
        </p>
      )}
      {finish.error && <ErrorMessage>{refusalText(finish.error)}</ErrorMessage>}
      <div className="flex flex-wrap gap-2">
        {machine && isReady(machine) && (
          <Button
            onClick={() => {
              finish.mutate();
            }}
            disabled={finish.isPending}
          >
            Continue
          </Button>
        )}
        <Button
          variant={machine && isReady(machine) ? 'secondary' : 'primary'}
          onClick={() => {
            finish.mutate();
          }}
          disabled={finish.isPending}
        >
          Skip for now
        </Button>
      </div>
    </WizardStep>
  );
}

/** Step 4's form: the machine's name, and its Claude account when there are several. */
function MachineForm({
  accounts,
  onCreated,
}: {
  accounts: ClaudeAccount[];
  onCreated: (result: EnrollmentResponse) => void;
}) {
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: (input: CreateMachineRequest) =>
      api('POST', '/api/machines', EnrollmentResponse, input),
    onSuccess: async (result) => {
      onCreated(result);
      await machinesChanged(result.machine);
    },
  });
  const chosen = accountId || (accounts.length === 1 ? (accounts[0]?.id ?? '') : '');
  const nameError = touched && name.trim() === '' ? 'Enter a name.' : null;
  const accountError = touched && chosen === '' ? 'Choose the Claude account.' : null;
  const nameTaken =
    create.error instanceof ApiRequestError && create.error.code === 'machine_name_taken';

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setTouched(true);
    if (name.trim() === '' || chosen === '') return;
    create.mutate({ name: name.trim(), accountId: chosen });
  }

  return (
    <form className="space-y-4" onSubmit={submit} aria-label="New machine" noValidate>
      <TextField
        label="Name"
        hint="How the Orchestrator names this computer, for example “Desktop”."
        value={name}
        maxLength={NAME_MAX_LENGTH}
        error={nameError ?? (nameTaken ? refusalText(create.error) : null)}
        onChange={(event) => {
          setName(event.target.value);
          create.reset();
        }}
      />
      {accounts.length > 1 && (
        <SelectField
          label="Claude account"
          hint="The account you will log into on this machine."
          value={chosen}
          error={accountError}
          onChange={(event) => {
            setAccountId(event.target.value);
            create.reset();
          }}
        >
          <option value="">Choose…</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </SelectField>
      )}
      {create.error && !nameTaken && <ErrorMessage>{refusalText(create.error)}</ErrorMessage>}
      <Button type="submit" disabled={create.isPending}>
        Show the commands
      </Button>
    </form>
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
        <DoneText />
        <p>
          The Help section explains everything the Orchestrator does, starting with the{' '}
          <Link to="/help/getting-started" className="text-blue-700 underline">
            getting started guide
          </Link>
          .
        </p>
      </Card>
    </CenteredPage>
  );
}

/**
 * What the wizard set up and what comes next: a first request once a Claude account exists (steps
 * 3 and 4, lot 5 step J); before, as an install from before 0.6.0 finishing step 2 sees it, the
 * account and the machine to add in Machines.
 */
function DoneText() {
  const accounts = useAccounts();
  const machines = useMachines();
  if (accounts.isPending || machines.isPending) return <Loading />;
  const account = accounts.data?.accounts[0];
  if (!account) {
    return (
      <>
        <p>
          Your account is created and GitHub is connected. Next, add your Claude account and the
          computer where agents will work, in Machines: &quot;Needs you&quot; reminds you, and tells
          you whenever something needs your attention.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/help" className={buttonLinkClass}>
            Open Help
          </Link>
          <Link to="/" className={secondaryButtonLinkClass}>
            Go to Needs you
          </Link>
        </div>
      </>
    );
  }
  const list = machines.data?.machines.filter((machine) => machine.state !== 'revoked') ?? [];
  const ready = list.find(isReady);
  const enrolled = list.find((machine) => machine.enrolledAt !== null);
  return (
    <>
      <ul className="list-disc space-y-1 pl-6" aria-label="Set up">
        <li>Your account is created and GitHub is connected.</li>
        <li>Claude account: {account.label}.</li>
        <li>
          {ready
            ? `Machine: ${ready.name} is ready.`
            : enrolled
              ? `Machine: ${enrolled.name} is enrolled but cannot receive runs yet. Machines shows why.`
              : 'No machine yet: "Needs you" reminds you to add one, in Machines.'}
        </li>
      </ul>
      <h2 className="text-lg font-semibold text-slate-900">Next: your first request</h2>
      <p>
        Describe what you want in plain words, for example “A simple website with a home page and a
        contact form.” The Project Manager plans it into tickets and asks you to review the plan
        before any work starts.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/requests/new" className={buttonLinkClass}>
          Submit a first request
        </Link>
        <Link to="/help" className={secondaryButtonLinkClass}>
          Open Help
        </Link>
        <Link to="/" className={secondaryButtonLinkClass}>
          Go to Needs you
        </Link>
      </div>
    </>
  );
}
