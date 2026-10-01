import type { ControlStatus, DoctorCheck } from '@orchestrator/protocol';
import { probeControl } from './control.js';
import { findExecutable } from './exec.js';
import { Git } from './git.js';
import { describeLastStop, readLastStop } from './last-stop.js';
import { localBranches } from './local-branches.js';
import type { DaemonPaths } from './paths.js';

const CONNECTION_TEXT = {
  connected: 'connected',
  connecting: 'connecting',
  waiting: 'not connected, trying again soon',
} as const;

/** The first 7 characters of a commit hash, as Git shows it. */
function short(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * The local ticket branches and their commits not on GitHub yet (05, section 8), read from the
 * bare clones whether a daemon runs or not; a branch a live run uses says so.
 */
async function branchLines(
  paths: DaemonPaths,
  git: Git | null,
  runs: ControlStatus['runs'],
  out: (line: string) => void,
): Promise<void> {
  if (git === null) {
    out('Local ticket branches: Git is not found in this PATH, so they cannot be listed.');
    return;
  }
  const repositories = (await localBranches(paths, git)).filter(
    (each) => each.branches.length > 0 || each.error !== null,
  );
  if (repositories.length === 0) {
    out('Local ticket branches: none');
    return;
  }
  out('Local ticket branches, with their commits not on GitHub yet:');
  for (const { repository, branches, error } of repositories) {
    out(`  ${repository}`);
    if (error !== null) out(`    could not be read: ${error}`);
    for (const branch of branches) {
      const users = runs.filter(
        (run) => run.repository === repository && run.branch === branch.name,
      );
      const used = users
        .map((run) => `used by run ${run.runId}${run.ticket ? ` (${run.ticket})` : ''}`)
        .join(', ');
      out(`    ${branch.name}  head ${short(branch.head)}${used ? `  ${used}` : ''}`);
      if (branch.notOnGitHub.length === 0) out('      nothing that is not on GitHub');
      for (const commit of branch.notOnGitHub) out(`      ${short(commit.hash)} ${commit.subject}`);
    }
  }
}

/** Git from this terminal's PATH, or null when it is not there. */
function defaultGit(): Git | null {
  const file = findExecutable('git', process.env.PATH);
  return file === null ? null : new Git(file, process.env);
}

/**
 * `orchestrator-daemon status` (05, section 8): what the running daemon says on its control
 * socket, or the last stop reason when none runs, then the local ticket branches. Resolves with 0
 * when a daemon runs, 1 otherwise.
 */
export async function status(
  paths: DaemonPaths,
  out: (line: string) => void,
  git: Git | null = defaultGit(),
): Promise<number> {
  const probe = await probeControl(paths.controlSocket);
  if (probe.kind !== 'running') {
    out('No daemon is running.');
    const stop = await readLastStop(paths.lastStop);
    if (stop) out(describeLastStop(stop));
    out(
      'Start it with "systemctl --user start orchestrator-daemon" (service) or "orchestrator-daemon start" (in this terminal).',
    );
    await branchLines(paths, git, [], out);
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
  if (s.processScopes) for (const line of formatChecks([s.processScopes])) out(line);
  if (s.runs.length === 0) out('Runs: none');
  else {
    out('Runs:');
    for (const run of s.runs) {
      out(`  ${run.ticket ?? 'planning'}  run ${run.runId}  ${run.state}`);
    }
  }
  await branchLines(paths, git, s.runs, out);
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
