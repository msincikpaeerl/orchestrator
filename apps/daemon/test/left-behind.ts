import { readFileSync } from 'node:fs';
import { fake } from './runner-harness.js';

// Background processes an agent leaves behind, for the tests of their cleanup (lot 2 plan
// step K): `processes.test.ts` without systemd, `systemd.test.ts` with its scopes.

/** Four background processes the agent leaves, each printing its pid. */
export const LEFT_BEHIND = [
  { do: 'bash', command: 'sleep 301 > /dev/null 2>&1 & echo "pid $!"' },
  { do: 'bash', command: 'nohup sleep 302 > /dev/null 2>&1 & echo "pid $!"' },
  { do: 'bash', command: 'setsid sleep 303 > /dev/null 2>&1 & echo "pid $!"' },
  { do: 'bash', command: '( ( sleep 304 > /dev/null 2>&1 & echo "pid $!" ) & )' },
] as const;

/** The pids the scenario's commands printed. */
export async function leftPids(): Promise<number[]> {
  return (await fake.log()).flatMap((entry) =>
    entry.event === 'bash'
      ? [...entry.output.matchAll(/pid (\d+)/g)].map((match) => Number(match[1]))
      : [],
  );
}

/** Whether `pid` still runs with the run's marker (a zombie or a reused pid does not count). */
export function running(pid: number, runId: string): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, 'latin1')
      .split('\0')
      .includes(`ORCHESTRATOR_RUN_ID=${runId}`);
  } catch {
    return false;
  }
}
