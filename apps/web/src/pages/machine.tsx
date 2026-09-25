import { EnrollmentResponse, Machine, type Enrollment } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  ConfirmDialog,
  ErrorMessage,
  HelpLink,
  InfoMessage,
  Loading,
  PageHeader,
  WarningMessage,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { CapabilitiesEditor } from '../machines/capabilities';
import { Command } from '../machines/command';
import { EnrollmentSteps } from '../machines/enrollment';
import {
  claudeCodeText,
  doctorStatusLabel,
  osLabel,
  RESTART_COMMAND,
  unusableText,
} from '../machines/text';
import { machinesChanged, useMachine } from '../queries';
import { refusalText } from '../refusals';
import { MachineBadges } from './machines';

const doctorLook: Record<Machine['doctor'][number]['status'], string> = {
  ok: 'text-green-800',
  warning: 'text-amber-800',
  error: 'text-red-800',
  check_yourself: 'text-blue-800',
};

/** What keeps the machine from working, and how to fix it (02, section 4). */
function Problems({ machine }: { machine: Machine }) {
  if (machine.state === 'revoked') return null;
  return (
    <>
      {machine.updateCommand !== null && (
        <WarningMessage>
          <span className="block font-medium">
            The daemon on this machine does not match this version of the Orchestrator, so it cannot
            connect. On the machine, install the daemon of this version:
          </span>
          <Command command={machine.updateCommand} label="Update command" />
          <span className="mt-2 block">Then restart the daemon:</span>
          <Command command={RESTART_COMMAND} label="Restart command" />
        </WarningMessage>
      )}
      {machine.unusable.length > 0 && (
        <WarningMessage>
          <span className="block font-medium">This machine cannot receive runs:</span>
          {machine.unusable.map((reason) => (
            <span
              key={reason.type === 'doctor_error' ? reason.check.name : reason.type}
              className="block"
            >
              {unusableText(reason)}
            </span>
          ))}
          <span className="mt-2 block">
            Fix this on the machine, then restart the daemon so it checks again:
          </span>
          <Command command={RESTART_COMMAND} label="Restart command" />
        </WarningMessage>
      )}
    </>
  );
}

function Details({ machine }: { machine: Machine }) {
  const claudeCode = claudeCodeText(machine);
  const rows: [string, string | null][] = [
    ['Claude account', machine.account.label],
    ['System', machine.os === null ? null : osLabel[machine.os]],
    ['Daemon version', machine.daemonVersion],
    ['Claude Code version', machine.daemonVersion === null ? null : claudeCode.text],
    [
      'Last heard from',
      machine.lastHeartbeatAt === null ? null : formatDateTime(machine.lastHeartbeatAt),
    ],
    ['Enrolled', machine.enrolledAt === null ? null : formatDateTime(machine.enrolledAt)],
    ['Disabled', machine.disabledAt === null ? null : formatDateTime(machine.disabledAt)],
    ['Revoked', machine.revokedAt === null ? null : formatDateTime(machine.revokedAt)],
  ];
  return (
    <Card className="space-y-3">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-slate-600">{term}</dt>
              <dd className="font-medium break-words">{value}</dd>
            </div>
          ))}
      </dl>
      {machine.daemonVersion === null && (
        <p className="text-slate-700">
          The versions and the system appear once the machine has connected.
        </p>
      )}
      {claudeCode.warning && <WarningMessage>{claudeCode.warning}</WarningMessage>}
    </Card>
  );
}

/**
 * The results of the daemon's `doctor` at its last connection (05, section 8). A link comes from
 * the machine: only web addresses are shown.
 */
function Doctor({ machine }: { machine: Machine }) {
  if (machine.doctor.length === 0) return null;
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Checks on the machine</h2>
      <ul aria-label="Checks on the machine" className="space-y-2">
        {machine.doctor.map((check) => (
          <li key={check.name}>
            <span className={`font-medium ${doctorLook[check.status]}`}>
              {doctorStatusLabel[check.status]}
            </span>{' '}
            · {check.name}: {check.message}{' '}
            {check.link !== null && /^https?:\/\//.test(check.link) && (
              <a
                href={check.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-700 underline"
              >
                How to fix
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A new enrollment code: for a machine waiting for enrollment, or revoked (01, section 3.8). */
function NewCode({
  machine,
  onIssued,
}: {
  machine: Machine;
  onIssued: (enrollment: Enrollment) => void;
}) {
  const issue = useMutation({
    mutationFn: () =>
      api('POST', `/api/machines/${machine.id}/enrollment-code`, EnrollmentResponse),
    onSuccess: async (result) => {
      onIssued(result.enrollment);
      await machinesChanged(result.machine);
    },
  });
  const revoked = machine.state === 'revoked';
  return (
    <InfoMessage>
      <div className="space-y-2">
        <p>
          {revoked
            ? 'This machine is revoked: its daemon can no longer connect. To use this computer again, generate a new enrollment code and enroll it again.'
            : machine.enrollmentCodeExpiresAt === null
              ? 'This machine has not enrolled yet, and its enrollment code has expired or was used.'
              : `This machine has not enrolled yet. Its enrollment code works until ${formatDateTime(machine.enrollmentCodeExpiresAt)}; generate a new one to see the commands again.`}
        </p>
        {issue.error && <ErrorMessage>{refusalText(issue.error)}</ErrorMessage>}
        <Button
          onClick={() => {
            issue.mutate();
          }}
          disabled={issue.isPending}
        >
          New enrollment code
        </Button>
      </div>
    </InfoMessage>
  );
}

/** Disable and enable, and revoke after a confirmation (02, section 9.2). */
function Actions({ machine }: { machine: Machine }) {
  const [asking, setAsking] = useState(false);
  const act = useMutation({
    mutationFn: (action: 'disable' | 'enable' | 'revoke') =>
      api('POST', `/api/machines/${machine.id}/${action}`, Machine),
    onSuccess: async (changed) => {
      setAsking(false);
      await machinesChanged(changed);
    },
  });
  if (machine.state === 'revoked' || machine.state === 'waiting_enrollment') return null;
  const disabled = machine.disabledAt !== null;

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Actions</h2>
      <p className="text-slate-700">
        {disabled
          ? 'This machine is disabled: it stays connected but gets no new runs.'
          : 'Disable a machine to stop giving it new runs; runs already on it finish. Revoke it if the computer is lost or you stop using it.'}
      </p>
      {act.error && !asking && <ErrorMessage>{refusalText(act.error)}</ErrorMessage>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={act.isPending}
          onClick={() => {
            act.mutate(disabled ? 'enable' : 'disable');
          }}
        >
          {disabled ? 'Enable' : 'Disable'}
        </Button>
        <Button
          variant="secondary"
          disabled={act.isPending}
          onClick={() => {
            act.reset();
            setAsking(true);
          }}
        >
          Revoke
        </Button>
      </div>
      {asking && (
        <ConfirmDialog
          title={`Revoke ${machine.name}?`}
          confirmLabel="Revoke"
          busy={act.isPending}
          error={act.error && <ErrorMessage>{refusalText(act.error)}</ErrorMessage>}
          onConfirm={() => {
            act.mutate('revoke');
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            The daemon on this machine is disconnected at once and its token never works again. Runs
            still active on it fail.
          </p>
          <p>
            The machine stays in the list. To use this computer again, generate a new enrollment
            code and enroll it again.
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

/** A machine (02, section 9.2). */
export function MachinePage() {
  const { id = '' } = useParams();
  const machine = useMachine(id);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  if (machine.isPending) return <Loading />;
  if (machine.isError) {
    const missing =
      machine.error instanceof ApiRequestError && machine.error.code === 'machine_not_found';
    return (
      <div className="space-y-3">
        <ErrorMessage>
          {missing
            ? 'This machine does not exist.'
            : 'The machine could not be loaded. Reload the page.'}
        </ErrorMessage>
        <Link to="/machines" className="text-blue-700 underline">
          Back to the machines
        </Link>
      </div>
    );
  }
  const data = machine.data;
  const showCode = enrollment !== null && data.enrolledAt === null;

  return (
    <>
      <Link to="/machines" className="text-sm text-blue-700 underline">
        Machines
      </Link>
      <PageHeader title={data.name} help="machines" />
      <div className="space-y-4">
        <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-2">
          <MachineBadges machine={data} />
        </div>
        <Problems machine={data} />
        {showCode ? (
          <EnrollmentSteps enrollment={enrollment} machine={data} />
        ) : (
          (data.state === 'waiting_enrollment' || data.state === 'revoked') && (
            <NewCode machine={data} onIssued={setEnrollment} />
          )
        )}
        <Details machine={data} />
        <Doctor machine={data} />
        <Card className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Capabilities</h2>
            <HelpLink page="machines#capabilities" />
          </div>
          <p className="text-slate-700">
            The tools this machine has. The daemon detects some; add the others and remove those
            agents should not rely on.
          </p>
          <CapabilitiesEditor machine={data} />
        </Card>
        <Actions machine={data} />
      </div>
    </>
  );
}
