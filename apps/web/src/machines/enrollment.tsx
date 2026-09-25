import type { Enrollment, Machine } from '@orchestrator/protocol';
import { Link } from 'react-router';
import { Card, HelpLink, InfoMessage, WarningMessage } from '../components/ui';
import { formatDateTime } from '../github/text';
import { Command } from './command';
import { unusableText } from './text';

/** Where the machine being added is: waiting for its daemon, then connected (02, section 9.2). */
function ConnectionStatus({ machine }: { machine: Machine }) {
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
        <Link to={`/machines/${machine.id}`} className="text-blue-700 underline">
          Open the machine
        </Link>
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
        <Link to={`/machines/${machine.id}`} className="text-blue-700 underline">
          Open the machine
        </Link>
      </WarningMessage>
    );
  }
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
 * section 9.2; 05, section 3.1). The code is shown only here, once.
 */
export function EnrollmentSteps({
  enrollment,
  machine,
}: {
  enrollment: Enrollment;
  machine: Machine;
}) {
  const expired =
    machine.state === 'waiting_enrollment' && new Date(enrollment.expiresAt) <= new Date();
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Connect {machine.name}</h2>
      <p className="text-slate-700">
        Type these commands in a terminal of the computer you are adding (in Ubuntu on Windows). It
        needs Node.js, Git, tmux and Claude Code first: see{' '}
        <HelpLink page="machines#before-you-start">Before you start</HelpLink>.
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
          This code has expired. Open the machine and click <strong>New enrollment code</strong>.
        </WarningMessage>
      ) : (
        <ConnectionStatus machine={machine} />
      )}
      <p className="text-sm text-slate-600">
        On Windows, also keep WSL running: see{' '}
        <HelpLink page="machines#keep-wsl-running">Keep WSL running</HelpLink>.
      </p>
    </Card>
  );
}
