import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { RunId } from '@orchestrator/protocol';
import { findExecutable, runCommand } from './exec.js';
import { UserError } from './errors.js';
import { TMUX_SOCKET_NAME } from './paths.js';

/** The tmux session of a run (05, section 4.3). */
export function sessionName(runId: string): string {
  return `orch-${runId}`;
}

/**
 * `orchestrator-daemon attach <run-id> [--write]` (05, section 8): watches a run's session on the
 * daemon's tmux server, read-only unless `--write` is confirmed. Resolves with tmux's exit code.
 */
export async function attach(
  runId: string,
  write: boolean,
  io: { input: NodeJS.ReadableStream; out: (line: string) => void },
): Promise<number> {
  if (!RunId.safeParse(runId).success) {
    throw new UserError(`"${runId}" is not a run id: copy it from the run's page.`);
  }
  const tmux = findExecutable('tmux', process.env.PATH);
  if (!tmux) throw new UserError("tmux is not installed, or not in this terminal's PATH.");
  // Inside the owner's own tmux, TMUX would make tmux refuse to attach another server's session.
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const target = `=${sessionName(runId)}`;
  const exists = await runCommand(tmux, ['-L', TMUX_SOCKET_NAME, 'has-session', '-t', target], {
    env,
  });
  if (exists?.code !== 0) {
    throw new UserError(`No live session for run ${runId} on this machine.`);
  }
  if (write) {
    io.out(
      "Warning: what you type goes to the agent's session and interferes with its work. Watch without --write to only look.",
    );
    const prompt = createInterface({ input: io.input, output: process.stdout, terminal: false });
    const answer = await prompt.question('Type "yes" to type in the session: ');
    prompt.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      io.out('Not attached.');
      return 1;
    }
  } else {
    io.out('Watching read-only. Leave with Ctrl+B then D.');
  }
  const args = ['-L', TMUX_SOCKET_NAME, 'attach-session', ...(write ? [] : ['-r']), '-t', target];
  return new Promise((resolve, reject) => {
    const child = spawn(tmux, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
