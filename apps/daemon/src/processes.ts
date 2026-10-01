import { readdirSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';

// The processes a run's session leaves behind (05, section 4.11; lot 2 plan step K). Closing the
// tmux session sends `SIGHUP` to its terminal only: a `nohup`, `setsid` or double-forked process
// survives it. Every process of a run carries a marker in its environment, inherited whatever it
// does to its session or process group; the sweep finds them in `/proc` and stops them.

/** The marker set on each run's tmux session: `ORCHESTRATOR_RUN_ID=<run id>`. */
export const RUN_MARKER = 'ORCHESTRATOR_RUN_ID';

/**
 * How long a process has after `SIGTERM` before `SIGKILL`: a code constant, like the reconnection
 * backoff, since it only gives a well-behaved program time to exit (04, section 8). The run scopes
 * get the same time from systemd (`TimeoutStopSec`), and the sweep keeps sending `SIGKILL` for at
 * most this long before it logs a process that will not die.
 */
export const SWEEP_GRACE_MS = 5000;

/**
 * Processes of this user whose environment holds the run's marker. Other users' processes cannot
 * be read and are skipped; a zombie has no environment left and is already gone for this purpose.
 */
export function markedProcesses(runId: string, procRoot = '/proc'): number[] {
  const marker = `${RUN_MARKER}=${runId}`;
  const found: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environment = readFileSync(`${procRoot}/${entry}/environ`, 'latin1');
      if (environment.split('\0').includes(marker)) found.push(pid);
    } catch {
      // Gone, or not this user's process.
    }
  }
  return found;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * Stops every process still carrying the run's marker: `SIGTERM`, then `SIGKILL` for those left
 * after the grace period, and resolves once none is left, so nothing of the run can still write
 * when it returns. `SIGKILL` is sent again until `/proc` shows no marked process: one forked
 * between a look at `/proc` and the signal, or not yet gone after its `SIGKILL`, is caught by the
 * next look. A process `SIGKILL` cannot end within another grace period (stuck in the kernel) is
 * logged and left. Returns what it stopped, for the log. A process that cleared its environment
 * escapes the sweep, not the run's systemd scope when there is one.
 */
export async function sweepRun(
  runId: string,
  log: Logger,
  graceMs = SWEEP_GRACE_MS,
): Promise<{ terminated: number[]; killed: number[] }> {
  const terminated = markedProcesses(runId);
  if (terminated.length === 0) return { terminated, killed: [] };
  for (const pid of terminated) signal(pid, 'SIGTERM');
  const graceEnd = Date.now() + graceMs;
  while (Date.now() < graceEnd) {
    const still = new Set(markedProcesses(runId));
    if (terminated.every((pid) => !still.has(pid))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Processes started meanwhile by the ones stopping carry the marker too.
  const killed = new Set<number>();
  const killEnd = Date.now() + graceMs;
  for (;;) {
    const left = markedProcesses(runId);
    if (left.length === 0) break;
    if (Date.now() >= killEnd) {
      log.error({ left }, 'processes left by the session did not end after SIGKILL');
      break;
    }
    for (const pid of left) {
      signal(pid, 'SIGKILL');
      killed.add(pid);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  log.info({ terminated, killed: [...killed] }, 'processes left by the session stopped');
  return { terminated, killed: [...killed] };
}
