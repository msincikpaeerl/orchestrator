import type { Machine, Run } from '@orchestrator/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, buttonLinkClass, Card, ErrorMessage, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../github/text';
import { AccountForm } from '../machines/account-form';
import { concurrentRuns, osLabel, planLabel, statusText } from '../machines/text';
import { useAccounts, useLiveRuns, useMachines } from '../queries';
import { AccountStatusText } from '../runs/components';
import { runPath, runStateText } from '../runs/text';

const badgeLook: Record<Machine['state'], string> = {
  online: 'bg-green-100 text-green-900',
  offline: 'bg-slate-200 text-slate-800',
  disabled: 'bg-amber-100 text-amber-900',
  waiting_enrollment: 'bg-blue-100 text-blue-900',
  revoked: 'bg-red-100 text-red-900',
};

/** The machine's status label, and what keeps it from receiving runs (02, section 9.2). */
export function MachineBadges({ machine }: { machine: Machine }) {
  return (
    <>
      <span className={`rounded px-2 py-0.5 text-sm ${badgeLook[machine.state]}`}>
        {statusText(machine)}
      </span>
      {machine.state !== 'revoked' && machine.daemonIncompatible && (
        <span className="rounded bg-red-100 px-2 py-0.5 text-sm text-red-900">
          Daemon to update
        </span>
      )}
      {machine.state !== 'revoked' && machine.unusable.length > 0 && (
        <span className="rounded bg-red-100 px-2 py-0.5 text-sm text-red-900">
          Cannot receive runs
        </span>
      )}
    </>
  );
}

/** A machine's active runs, each linked to its run page (02, section 9.2). */
export function ActiveRunList({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <p className="text-slate-700">No active run.</p>;
  return (
    <ul aria-label="Active runs" className="space-y-1">
      {runs.map((run) => (
        <li key={run.id} className="break-words">
          <Link to={runPath(run.id)} className="text-blue-700 underline">
            {run.ticket}
          </Link>{' '}
          · {run.profile.name} · {runStateText(run)}
        </li>
      ))}
    </ul>
  );
}

/** Claude accounts: list, add and edit (02, section 9.1). */
function Accounts() {
  const accounts = useAccounts();
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => {
    setEditing(null);
  };

  return (
    <section aria-labelledby="accounts-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="accounts-title" className="text-xl font-semibold text-slate-900">
          Claude accounts
        </h2>
        {editing !== 'new' && (
          <Button
            variant="secondary"
            onClick={() => {
              setEditing('new');
            }}
          >
            Add a Claude account
          </Button>
        )}
      </div>
      {editing === 'new' && (
        <Card>
          <AccountForm onDone={close} />
        </Card>
      )}
      {accounts.isPending ? (
        <Loading />
      ) : accounts.isError ? (
        <ErrorMessage>The Claude accounts could not be loaded. Reload the page.</ErrorMessage>
      ) : accounts.data.accounts.length === 0 ? (
        editing !== 'new' && (
          <Card>
            <p>
              No Claude account yet. Add the account your machines are logged into with{' '}
              <strong>Add a Claude account</strong>.
            </p>
          </Card>
        )
      ) : (
        <ul aria-label="Claude accounts" className="space-y-3">
          {accounts.data.accounts.map((account) => (
            <li key={account.id}>
              <Card>
                {editing === account.id ? (
                  <AccountForm account={account} onDone={close} />
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <h3 className="font-semibold break-words text-slate-900">{account.label}</h3>
                      <p className="text-slate-700">
                        {planLabel[account.plan]} · {concurrentRuns(account.maxConcurrentRuns)}
                      </p>
                      <p className="text-slate-900">
                        State: <AccountStatusText account={account} />
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      className="shrink-0"
                      aria-label={`Edit ${account.label}`}
                      onClick={() => {
                        setEditing(account.id);
                      }}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The machine list (02, section 9.2). */
function Machines() {
  const machines = useMachines();
  const accounts = useAccounts();
  const live = useLiveRuns();
  const noAccount = accounts.data?.accounts.length === 0;

  return (
    <section aria-labelledby="machines-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="machines-title" className="text-xl font-semibold text-slate-900">
          Machines
        </h2>
        {!noAccount && (
          <Link to="/machines/new" className={buttonLinkClass}>
            Add machine
          </Link>
        )}
      </div>
      {machines.isPending ? (
        <Loading />
      ) : machines.isError ? (
        <ErrorMessage>The machines could not be loaded. Reload the page.</ErrorMessage>
      ) : machines.data.machines.length === 0 ? (
        <Card>
          <p>
            {noAccount
              ? 'No machine yet. Add a Claude account first: each machine uses one.'
              : 'No machine yet. Click Add machine to connect the computer where agents will work.'}
          </p>
        </Card>
      ) : (
        <ul aria-label="Machines" className="space-y-3">
          {machines.data.machines.map((machine) => (
            <li key={machine.id}>
              <Card className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/machines/${machine.id}`}
                    className="font-semibold break-words text-blue-700 underline"
                  >
                    {machine.name}
                  </Link>
                  <MachineBadges machine={machine} />
                </div>
                <p className="text-slate-700">
                  Claude account {machine.account.label}
                  {machine.os !== null && ` · ${osLabel[machine.os]}`}
                </p>
                {machine.lastHeartbeatAt !== null && machine.state !== 'revoked' && (
                  <p className="text-sm text-slate-600">
                    Last heard from {formatDateTime(machine.lastHeartbeatAt)}
                  </p>
                )}
                <ActiveRunList
                  runs={live.data?.runs.filter((run) => run.machine.id === machine.id) ?? []}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Machines and Claude accounts (02, section 9). */
export function MachinesPage() {
  return (
    <>
      <PageHeader title="Machines" help="machines" />
      <div className="space-y-8">
        <Accounts />
        <Machines />
      </div>
    </>
  );
}
