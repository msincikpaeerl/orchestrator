import type { DoctorCheck } from '@orchestrator/protocol';
import { probeControl } from './control.js';
import { describeLastStop, readLastStop } from './last-stop.js';
import type { DaemonPaths } from './paths.js';

const CONNECTION_TEXT = {
  connected: 'connected',
  connecting: 'connecting',
  waiting: 'not connected, trying again soon',
} as const;

/**
 * `orchestrator-daemon status` (05, section 8): what the running daemon says on its control
 * socket, or the last stop reason when none runs. Resolves with 0 when a daemon runs, 1 otherwise.
 */
export async function status(paths: DaemonPaths, out: (line: string) => void): Promise<number> {
  const probe = await probeControl(paths.controlSocket);
  if (probe.kind !== 'running') {
    out('No daemon is running.');
    const stop = await readLastStop(paths.lastStop);
    if (stop) out(describeLastStop(stop));
    out(
      'Start it with "systemctl --user start orchestrator-daemon" (service) or "orchestrator-daemon start" (in this terminal).',
    );
    return 1;
  }
  const s = probe.status;
  out(
    `Daemon ${s.daemonVersion} running ${s.mode === 'service' ? 'as the service' : 'in a terminal'} (process ${String(s.pid)}, since ${new Date(s.startedAt).toLocaleString()}).`,
  );
  out(`Machine: ${s.machineName}`);
  out(`Orchestrator: ${s.serverUrl}`);
  out(
    `Connection: ${CONNECTION_TEXT[s.connection]}${s.connectedAt ? ` (since ${new Date(s.connectedAt).toLocaleString()})` : ''}${s.lastError && s.connection !== 'connected' ? `; last problem: ${s.lastError}` : ''}`,
  );
  out(`Claude Code: ${s.claudeCodeVersion ?? 'not found'}`);
  out(`System: ${s.os === 'wsl' ? 'Linux on WSL' : 'Linux'}`);
  out(`Capabilities detected: ${s.capabilities.length > 0 ? s.capabilities.join(', ') : 'none'}`);
  out(
    s.runs.length > 0
      ? `Runs: ${s.runs.map((run) => `${run.runId} (${run.state})`).join(', ')}`
      : 'Runs: none',
  );
  return 0;
}

const LABELS: Record<DoctorCheck['status'], string> = {
  ok: 'OK',
  warning: 'WARNING',
  error: 'ERROR',
  check_yourself: 'CHECK THIS YOURSELF',
};

/** One line per check for the `doctor` command, the link on its own line. */
export function formatChecks(checks: DoctorCheck[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${LABELS[check.status].padEnd(8)} ${check.name}: ${check.message}`);
    if (check.link) lines.push(`         ${check.link}`);
  }
  return lines;
}
