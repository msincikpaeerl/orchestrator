import {
  CLAUDE_CODE_VALIDATED_VERSION,
  type AccountPlan,
  type DoctorCheck,
  type Machine,
  type MachineOs,
  type MachineState,
  type NeedsYouItem,
  type UnusableReason,
} from '@orchestrator/protocol';

/** Claude plans in plain words (01, section 3.9). */
export const planLabel: Record<AccountPlan, string> = {
  pro: 'Pro',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
};

/** `1 run at a time`, `3 runs at a time`. */
export function concurrentRuns(count: number): string {
  return `${String(count)} run${count === 1 ? '' : 's'} at a time`;
}

/** The machine's status label (02, section 9.2). */
export const stateLabel: Record<MachineState, string> = {
  revoked: 'Revoked',
  waiting_enrollment: 'Waiting for enrollment',
  disabled: 'Disabled',
  online: 'Online',
  offline: 'Offline',
};

/** "Disabled" also says whether the machine is connected. */
export function statusText(machine: Machine): string {
  if (machine.state !== 'disabled') return stateLabel[machine.state];
  return `Disabled (${machine.online ? 'online' : 'offline'})`;
}

export const osLabel: Record<MachineOs, string> = {
  linux: 'Linux',
  wsl: 'Windows (WSL)',
};

/** The command restarting the daemon's service after an update or a fix (05, section 2). */
export const RESTART_COMMAND = 'systemctl --user restart orchestrator-daemon';

/** Why a machine cannot receive runs, in plain words. */
export function unusableText(reason: UnusableReason): string {
  switch (reason.type) {
    case 'claude_code_unsupported':
      return reason.version === null
        ? `Claude Code was not found on this machine. Install Claude Code ${reason.minimum} or later.`
        : `Claude Code ${reason.version} is too old. Update it to ${reason.minimum} or later.`;
    case 'doctor_error':
      return `Problem found by doctor: ${reason.check.name}: ${reason.check.message}`;
    case 'daemon_outdated':
      return `${olderDaemon(reason.daemonVersion, reason.serverVersion)} ${updateTo(reason.serverVersion)}`;
  }
}

/**
 * A daemon of the previous protocol (05, section 3.3): "Daemon 0.3.0 is older than this
 * Orchestrator (0.4.0)", or, when both have the same version number (a server built between two
 * releases), a sentence that stays true.
 */
function olderDaemon(daemonVersion: string, serverVersion: string): string {
  return daemonVersion === serverVersion
    ? `Daemon ${daemonVersion} is older than this Orchestrator, though both say version ${serverVersion}.`
    : `Daemon ${daemonVersion} is older than this Orchestrator (${serverVersion}).`;
}

/**
 * What to do about a daemon of the previous protocol (09, section 6; owner's answer, lot 5 step B):
 * the version is the server's own, 0.6.0 once lot 5 is released.
 */
function updateTo(serverVersion: string): string {
  return `Update the daemon to ${serverVersion}: the machine receives no runs until then.`;
}

/** A build as shown: its 16 digits, or why there is none. */
export function buildText(build: string | null, protocolVersion: number | null): string {
  if (build !== null) return build;
  return protocolVersion !== null && protocolVersion < 2
    ? 'Not reported (older daemon)'
    : 'None (run from its sources)';
}

/**
 * Why the machine page shows the update commands (05, section 3.3), or null when it does not.
 * The other build may be older or newer: the text says neither.
 */
export function daemonUpdateText(machine: Machine): string | null {
  if (machine.updateCommands === null) return null;
  if (machine.daemonIncompatible) {
    return 'The daemon on this machine does not match this version of the Orchestrator, so it cannot connect. On the machine, type these commands one after the other:';
  }
  const outdated = machine.unusable.find((reason) => reason.type === 'daemon_outdated');
  if (outdated) {
    return `${olderDaemon(outdated.daemonVersion, outdated.serverVersion)} ${updateTo(outdated.serverVersion)} On the machine, type these commands one after the other:`;
  }
  return 'The daemon on this machine is not the one this Orchestrator provides: it is another build, older or newer. The machine still receives runs. When no agent works on it, type these commands on the machine, one after the other:';
}

/**
 * The Claude Code version as the machine page shows it, with a warning above the highest version
 * validated with this Orchestrator (05, section 2); null before the first connection.
 */
export function claudeCodeText(machine: Machine): { text: string; warning: string | null } {
  if (machine.claudeCodeSupport === null) return { text: 'Not reported yet', warning: null };
  const version = machine.claudeCodeVersion ?? 'Not found';
  switch (machine.claudeCodeSupport) {
    case 'missing':
      return { text: 'Not found', warning: null };
    case 'below_minimum':
      return { text: `${version} (too old)`, warning: null };
    case 'supported':
      return { text: version, warning: null };
    case 'above_validated':
      return {
        text: version,
        warning: `This version is newer than ${CLAUDE_CODE_VALIDATED_VERSION}, the latest one checked with this version of the Orchestrator. Runs are still allowed. If runs fail to start, see Help.`,
      };
  }
}

export const doctorStatusLabel: Record<DoctorCheck['status'], string> = {
  ok: 'OK',
  warning: 'Warning',
  error: 'Error',
  check_yourself: 'Check this yourself',
};

/** Where a capability comes from, as the editor shows it next to the tag (02, section 9.2). */
export function capabilitySourceText(source: Machine['capabilitySources'][number]): string {
  switch (source.source) {
    case 'detected':
      return 'detected';
    case 'added':
      return source.detected ? 'added by you' : 'added by you, not detected';
    case 'removed':
      return source.detected ? 'removed by you, detected' : 'removed by you';
  }
}

/** The machine and account items of "Needs you": setup still to do and machine problems. */
export type MachineNeedsYouItem = Extract<
  NeedsYouItem,
  {
    type:
      | 'no_claude_account'
      | 'no_machine'
      | 'daemon_incompatible'
      | 'daemon_outdated'
      | 'daemon_build_differs'
      | 'claude_code_unsupported'
      | 'machine_problem'
      | 'machine_offline_with_runs';
  }
>;

/** Title and explanation of a machine or account item of "Needs you" (02, section 4). */
export function needsYouText(item: MachineNeedsYouItem): {
  title: string;
  detail: string;
} {
  switch (item.type) {
    case 'no_claude_account':
      return {
        title: 'No Claude account yet',
        detail:
          'Add the Claude account your machines are logged into, then add a machine. Agents need both to work.',
      };
    case 'no_machine':
      return {
        title: 'No machine enrolled yet',
        detail:
          'Add the computer where agents will work: install the Orchestrator daemon on it and connect it.',
      };
    case 'daemon_incompatible':
      return {
        title: `Update the daemon on ${item.machine.name}`,
        detail: `Its daemon${item.daemonVersion === null ? '' : ` ${item.daemonVersion}`} does not match this version of the Orchestrator, so it cannot connect. On that machine, type these commands one after the other.`,
      };
    case 'daemon_outdated':
      return {
        title: `Update the daemon on ${item.machine.name}`,
        detail: `${olderDaemon(item.daemonVersion, item.serverVersion)} ${updateTo(item.serverVersion)} On that machine, type these commands one after the other.`,
      };
    case 'daemon_build_differs':
      return {
        title: `The daemon on ${item.machine.name} is not the one this Orchestrator provides`,
        detail: `Its daemon (${item.daemonVersion}, ${item.daemonBuild === null ? 'run from its sources' : `build ${item.daemonBuild}`}) is another build than the one this Orchestrator provides (${item.serverVersion}, build ${item.providedBuild}): it may be older or newer. The machine still receives runs. When no agent works on it, type these commands on that machine, one after the other.`,
      };
    case 'claude_code_unsupported':
      return {
        title: `Claude Code not supported on ${item.machine.name}`,
        detail: `${
          item.version === null
            ? 'Claude Code was not found on this machine.'
            : `Claude Code ${item.version} is too old.`
        } Install or update Claude Code to ${item.minimum} or later on that machine, then restart the daemon. Until then, the machine receives no runs.`,
      };
    case 'machine_problem':
      return {
        title: `Problem on ${item.machine.name}`,
        detail: `The daemon's checks found ${
          item.checks.length === 1 ? 'a problem' : `${String(item.checks.length)} problems`
        }. Fix ${item.checks.length === 1 ? 'it' : 'them'} on that machine, then restart the daemon. Until then, the machine receives no runs.`,
      };
    case 'machine_offline_with_runs':
      return {
        title: `${item.machine.name} is offline with work on it`,
        detail: `The runs of ${item.tickets.join(', ')} are on this machine and wait for it. Start the machine and its daemon so they can go on.`,
      };
  }
}
