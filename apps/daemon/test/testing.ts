import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino, type Logger } from 'pino';
import { findExecutable } from '../src/exec.js';
import { daemonPaths, type DaemonPaths } from '../src/paths.js';
import { REAL_GITHUB_GIT_CONFIG, REAL_GITHUB_PROXY_ENV } from './real-github-guard.js';

export { TMUX_SOCKET_NAME } from '../src/paths.js';

// Test helpers for the daemon (`@orchestrator/daemon/testing`): a throw-away home folder, fake
// executables in a folder of their own, and the `orchestrator-daemon` command run from its
// TypeScript sources. Tests never touch the real home folder, systemd or Claude Code.

const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = createRequire(join(root, 'package.json')).resolve('tsx/cli');
const cliSource = join(root, 'src', 'cli.ts');

/** `orchestrator-daemon` from its sources: what hooks and Git helpers run in the tests. */
export const DAEMON_COMMAND: readonly string[] = [
  process.execPath,
  tsxCli,
  '--conditions=source',
  cliSource,
];

export interface TestHome {
  root: string;
  /** Holds the fake executables; first in PATH. */
  bin: string;
  paths: DaemonPaths;
  /** HOME, ORCHESTRATOR_HOME and XDG_CONFIG_HOME inside `root`; PATH is `bin` then Node.js. */
  env: NodeJS.ProcessEnv;
  remove(): Promise<void>;
}

/**
 * A test's own Git commands start no detached `git maintenance run --auto` or `gc --auto`: one
 * can outlive the test and write in a repository (a repack writes `info/refs`) while the home
 * is removed, which fails with ENOTEMPTY (lot 3 step D2, in CI). The daemon's own commands turn
 * them off by themselves (`git.ts`).
 */
const NO_BACKGROUND_GIT_CONFIG = ['[maintenance]', '\tauto = false', '[gc]', '\tauto = 0', ''].join(
  '\n',
);

export async function createTestHome(): Promise<TestHome> {
  // Short: a run's socket, `runs/<run id>/daemon.sock` under the home, must fit the 107 bytes
  // of a Unix socket path.
  const folder = await mkdtemp(join(tmpdir(), 'od-test-'));
  const bin = join(folder, 'bin');
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: join(folder, 'home'),
    ORCHESTRATOR_HOME: join(folder, 'home', '.orchestrator'),
    XDG_CONFIG_HOME: join(folder, 'home', '.config'),
    // Node.js's own folder, for `node` and `npm`; no system folder, so only fakes are found.
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    LANG: 'C.UTF-8',
    LOG_LEVEL: 'info',
    // The daemon's credentialed Git commands read no Git configuration of the test home, so its
    // github.com rewrite does not reach them: every address but the local ones goes through a
    // proxy where nothing listens (working rule 9; `real-github-guard.ts`).
    ...REAL_GITHUB_PROXY_ENV,
  };
  await mkdir(env.HOME ?? '', { recursive: true });
  // Git reads `$XDG_CONFIG_HOME/git/config` besides `~/.gitconfig`, which some tests write.
  await mkdir(join(env.XDG_CONFIG_HOME ?? '', 'git'), { recursive: true });
  await writeFile(
    join(env.XDG_CONFIG_HOME ?? '', 'git', 'config'),
    REAL_GITHUB_GIT_CONFIG + NO_BACKGROUND_GIT_CONFIG,
  );
  return {
    root: folder,
    bin,
    paths: daemonPaths(env),
    env,
    remove: () => rm(folder, { recursive: true, force: true }),
  };
}

/**
 * Links the host's own `name` (found in the PATH of the tests) into `folder`: runner tests use the
 * real `git` and `tmux` (ADR 0027). Throws when the host does not have it.
 */
export async function linkSystemTool(folder: string, name: string): Promise<string> {
  const found = findExecutable(name, process.env.PATH);
  if (!found) throw new Error(`${name} is needed by the daemon's tests: see docs/dev/setup.md`);
  const link = join(folder, name);
  await symlink(found, link);
  return link;
}

/** Writes an executable shell script named `name` in `folder`. */
export async function fakeExecutable(
  folder: string,
  name: string,
  script: string,
): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Shell code printing `text` with the shell's own `printf`: the test PATH has no `cat`. */
function print(text: string): string {
  return `printf '%s\\n' '${text.replace(/'/g, "'\\''")}'`;
}

/** A fake tool that prints `output` whatever its arguments. */
export function printing(folder: string, name: string, output: string): Promise<string> {
  return fakeExecutable(folder, name, print(output));
}

/** A fake tool that appends its arguments, one call per line, to `log`, and prints `output`. */
export function recording(folder: string, name: string, log: string, output = ''): Promise<string> {
  return fakeExecutable(folder, name, `echo "$*" >> '${log}'\n${output ? print(output) : ''}`);
}

/** Healthy fakes of every tool the daemon checks, for tests about something else. */
export async function healthyTools(home: TestHome): Promise<void> {
  await printing(home.bin, 'git', 'git version 2.53.0');
  await printing(home.bin, 'tmux', 'tmux 3.6');
  await printing(home.bin, 'claude', '2.1.282 (Claude Code)');
  await mkdir(home.paths.claudeConfig, { recursive: true });
  await writeFile(join(home.paths.claudeConfig, '.credentials.json'), '{}');
}

export interface DaemonProcess {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit code. */
  exited: Promise<number>;
  /**
   * Stops it and resolves once no process of it is left. tsx runs the daemon in a child process:
   * SIGTERM goes to tsx, which passes it on; SIGKILL goes to the whole process group, since tsx
   * cannot pass it on and the daemon would otherwise outlive the test.
   */
  stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/** Starts `orchestrator-daemon <args>` from the sources, with the test home's environment. */
export function spawnDaemon(args: string[], env: NodeJS.ProcessEnv, input?: string): DaemonProcess {
  // Its own process group, so that `stop` reaches the daemon tsx starts.
  const child = spawn(process.execPath, [tsxCli, '--conditions=source', cliSource, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  if (input !== undefined) child.stdin.end(input);
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  const stop = async (signal: 'SIGTERM' | 'SIGKILL') => {
    const group = child.pid;
    if (group === undefined) return;
    try {
      if (signal === 'SIGKILL') process.kill(-group, 'SIGKILL');
      else child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    await exited;
    await waitFor(
      () => groupProcesses(group).length === 0,
      10_000,
      `the end of the daemon's processes (group ${String(group)})`,
    );
  };
  return { child, stdout: () => stdout, stderr: () => stderr, exited, stop };
}

/** Runs `orchestrator-daemon <args>` to its end. */
export async function runDaemon(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = spawnDaemon(args, env, input);
  const code = await process.exited;
  return { code, stdout: process.stdout(), stderr: process.stderr() };
}

/** A logger keeping its lines, so tests can check what was logged (and what never was). */
export function captureLogger(): { log: Logger; lines: () => string[] } {
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) });
  return { log, lines: () => lines };
}

/** The processes of a process group, zombies left out (they hold nothing any more). */
function groupProcesses(group: number): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // `pid (name) state ppid pgrp ...`: the name may hold spaces and parentheses.
      const stat = readFileSync(`/proc/${entry}/stat`, 'latin1');
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(pgrp) === group && state !== 'Z') found.push(Number(entry));
    } catch {
      // Gone.
    }
  }
  return found;
}

/**
 * Processes started for a test home: they all run with its `HOME`, inherited from the test's
 * environment through tmux, the fake `claude`, hooks and spawned daemons. A zombie has no
 * environment left and is gone for this purpose.
 */
export function homeProcesses(home: TestHome): number[] {
  const marker = `HOME=${home.env.HOME ?? ''}`;
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(marker)) {
        found.push(Number(entry));
      }
    } catch {
      // Gone, or not this user's process.
    }
  }
  return found;
}

/**
 * Kills every process of the test home and waits until none is left, so nothing writes in the
 * home while it is removed: closing tmux only sends a hangup, which a process may ignore or
 * outlive for a moment.
 */
export async function stopHomeProcesses(home: TestHome): Promise<void> {
  await waitFor(
    () => {
      const pids = homeProcesses(home);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      return pids.length === 0;
    },
    10_000,
    "the end of the test home's processes",
  );
}

/** Polls `condition` every 50 ms until it holds, or throws after `timeoutMs`. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(`${what} not reached within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
