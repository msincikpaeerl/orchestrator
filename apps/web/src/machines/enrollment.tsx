import { EnrollmentResponse, type Enrollment, type Machine } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import {
  Button,
  Card,
  ErrorMessage,
  HelpLink,
  InfoMessage,
  WarningMessage,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { machinesChanged } from '../queries';
import { refusalText } from '../refusals';
import { Command } from './command';
import { unusableText } from './text';

/**
 * Where the machine being added is: waiting for its daemon, then connected (02, section 9.2).
 * Without `links` (the setup wizard), no link to the machine's page.
 */
export function ConnectionStatus({ machine, links }: { machine: Machine; links: boolean }) {
  if (machine.state === 'waiting_enrollment' || (machine.state === 'offline' && !machine.online)) {
    return (
      <InfoMessage>
        <p role="status" className="font-medium">
          {machine.state === 'waiting_enrollment'
            ? 'Waiting for the machine to enroll…'
            : 'Enrolled. Waiting for the daemon to connect…'}
        </p>
        <p className="text-sm">
          This page checks again each time you come back to it, for example after typing the
          commands in the terminal.
        </p>
      </InfoMessage>
    );
  }
  if (machine.online && machine.unusable.length === 0) {
    return (
      <p role="status" className="rounded border border-green-300 bg-green-50 px-3 py-2">
        <span className="font-medium text-green-900">Connected: {machine.name} is ready.</span>{' '}
        {links && (
          <Link to={`/machines/${machine.id}`} className="text-blue-700 underline">
            Open the machine
          </Link>
        )}
      </p>
    );
  }
  if (machine.online) {
    return (
      <WarningMessage>
        <span className="block font-medium">
          Connected, but {machine.name} cannot receive runs yet:
        </span>
        {machine.unusable.map((reason) => (
          <span
            key={reason.type === 'doctor_error' ? reason.check.name : reason.type}
            className="block"
          >
            {unusableText(reason)}
          </span>
        ))}
        {links && (
          <Link to={`/machines/${machine.id}`} className="text-blue-700 underline">
            Open the machine
          </Link>
        )}
      </WarningMessage>
    );
  }
  if (!links) return null;
  return (
    <p role="status">
      <Link to={`/machines/${machine.id}`} className="text-blue-700 underline">
        Open the machine
      </Link>
    </p>
  );
}

/**
 * The commands to type on the machine with a new enrollment code, then its connection (02,
 * section 9.2; 05, section 3.1). The code is shown only here, once. The setup wizard shows no
 * link to the machine's page (`links` false): its screens open once the wizard is left.
 */
export function EnrollmentSteps({
  enrollment,
  machine,
  links = true,
}: {
  enrollment: Enrollment;
  machine: Machine;
  links?: boolean;
}) {
  const expired =
    machine.state === 'waiting_enrollment' && new Date(enrollment.expiresAt) <= new Date();
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Connect {machine.name}</h2>
      <p className="text-slate-700">
        Type these commands in a terminal of the computer you are adding (in Ubuntu on Windows). It
        needs Node.js, Git, tmux, Claude Code and, on Windows, systemd turned on first: see{' '}
        <HelpLink page="machines#before-you-start" newTab={!links}>
          Before you start
        </HelpLink>
        .
      </p>
      <ol className="list-decimal space-y-4 pl-6">
        <li>
          Install the daemon, the Orchestrator’s program for this machine:
          <Command command={enrollment.installCommand} label="Install command" />
        </li>
        <li>
          Enroll the machine. The code works once, until {formatDateTime(enrollment.expiresAt)}.
          <Command command={enrollment.enrollCommand} label="Enroll command" />
        </li>
        <li>
          Log in to your Claude account, in the window that opens, then quit Claude Code:
          <Command command="orchestrator-daemon login" label="Login command" />
        </li>
        <li>
          Start the daemon as a service, so it runs in the background and after a restart:
          <Command command="orchestrator-daemon install-service" label="Service command" />
        </li>
      </ol>
      {expired ? (
        <WarningMessage>
          This code has expired. {links ? 'Open the machine and click' : 'Click'}{' '}
          <strong>New enrollment code</strong>.
        </WarningMessage>
      ) : (
        <ConnectionStatus machine={machine} links={links} />
      )}
      <p className="text-sm text-slate-600">
        On Windows, also keep WSL running: see{' '}
        <HelpLink page="machines#keep-wsl-running" newTab={!links}>
          Keep WSL running
        </HelpLink>
        .
      </p>
    </Card>
  );
}

/** A new enrollment code: for a machine waiting for enrollment, or revoked (01, section 3.8). */
export function NewEnrollmentCode({
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
