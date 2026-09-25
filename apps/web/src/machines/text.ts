import {
  CLAUDE_CODE_VALIDATED_VERSION,
  type AccountPlan,
  type ClaudeAccount,
  type DoctorCheck,
  type Machine,
  type MachineOs,
  type MachineState,
  type NeedsYouItem,
  type UnusableReason,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

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

/** An account's state (01, section 3.9): available, or limited until a time. */
export function accountStateText(account: ClaudeAccount): string {
  switch (account.state) {
    case 'available':
      return 'Available';
    case 'paused_manual':
      return 'Paused';
    case 'limited':
      return account.limitedUntil === null
        ? 'Usage limit reached'
        : `Usage limit reached, until ${formatDateTime(account.limitedUntil)}`;
  }
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
  }
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

/** Title and explanation of a machine or account item of "Needs you" (02, section 4). */
export function needsYouText(item: Exclude<NeedsYouItem, { type: 'project_setup_failed' }>): {
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
        title: 'No machine connected yet',
        detail:
          'Add the computer where agents will work: install the Orchestrator daemon on it and connect it.',
      };
    case 'daemon_incompatible':
      return {
        title: `Update the daemon on ${item.machine.name}`,
        detail: `Its daemon${item.daemonVersion === null ? '' : ` ${item.daemonVersion}`} does not match this version of the Orchestrator, so it cannot connect. On that machine, install the daemon of this version, then restart it.`,
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
  }
}
