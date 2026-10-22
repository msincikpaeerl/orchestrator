import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestHome,
  homeProcesses,
  linkSystemTool,
  runDaemon,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  TMUX_SOCKET_NAME,
  type DaemonProcess,
  type TestHome,
} from '@orchestrator/daemon/testing';
import { installFakeClaude, type FakeClaude } from '@orchestrator/daemon/testing/fake-claude';
import {
  ClaudeAccount,
  EnrollmentResponse,
  Machine,
  Run,
  RunLogResponse,
  TicketDetail,
  type DodReport,
} from '@orchestrator/protocol';
import { schema } from '@orchestrator/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect } from 'vitest';
import { RunHarness } from './run-harness.js';

// The acceptance scenarios' shared harness (lot 2 plan, step M; lot 3 step M; lot 4 step J): the
// real server, the real daemon process started from its sources as the owner types its commands,
// the host's tmux and Git, and the fake `claude` (working rule 10), in a throw-away test home per
// test. The owner's side goes through the API. Every wait is for an effect the owner could see
// (the API, `orchestrator-daemon status`), with a deadline. Used by `acceptance.test.ts` (lots 2
// and 3) and `acceptance-lot4.test.ts` (lot 4), so the CI shards can balance them.

export const TIMEOUT = 120_000;
/** Longest wait for one effect of the daemon (a fetch, a tmux session, a report). */
const EFFECT_MS = 30_000;
export const BRANCH = 't/1-contact-form';

export let home: TestHome;
export let fake: FakeClaude;
export let h: RunHarness;
export const daemons: DaemonProcess[] = [];
/** How far the application's clock is ahead of the real one, moved by the tests. */
export const clock = { ahead: 0 };

/**
 * Registers each test's home, fake `claude` and harness, then the clean-up checks after it: no
 * process of the test home left, nothing left of its folder or of the fake GitHub's (lot 3 step M).
 * Called once at the top of each acceptance test file.
 */
export function acceptanceHooks() {
  beforeEach(async () => {
    clock.ahead = 0;
    home = await createTestHome();
    await linkSystemTool(home.bin, 'git');
    await linkSystemTool(home.bin, 'tmux');
    fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
    // Each test's own tmux server folder: its `tmux -L orchestrator` never meets the owner's.
    const tmuxDir = join(home.root, 'tmux');
    await mkdir(tmuxDir, { mode: 0o700 });
    home.env.TMUX_TMPDIR = tmuxDir;
    home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
    // What `orchestrator-daemon login` leaves: the daemon checks the account is logged in.
    await mkdir(home.paths.claudeConfig, { recursive: true });
    await writeFile(join(home.paths.claudeConfig, '.credentials.json'), '{}');
    h = new RunHarness();
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      daemon.child.kill('SIGTERM');
      await daemon.exited;
    }
    tmux('kill-server');
    // Every process started for the test (daemon, tmux, the fake, hooks, relays) ends by itself
    // once the daemon and tmux are stopped; one left fails the test (lot 3 step M). It is killed
    // all the same, so nothing writes in the home folder while it is removed.
    const left = await processesLeft();
    await stopHomeProcesses(home);
    await h.stop();
    await home.remove();
    expect(left, 'processes of the test home still running').toEqual([]);
    // Nothing left of the test home, nor of the fake GitHub's repositories.
    expect(existsSync(home.root), home.root).toBe(false);
    if (githubRoot !== undefined) expect(existsSync(githubRoot), githubRoot).toBe(false);
    githubRoot = undefined;
  });
}

/** The fake GitHub's folder of the test's harness, once started. */
let githubRoot: string | undefined;

export async function startHarness(options: Parameters<RunHarness['start']>[0]) {
  await h.start(options);
  githubRoot = h.github.root;
}

/** The command lines of the test home's processes still running after a few seconds. */
async function processesLeft(): Promise<string[]> {
  await waitFor(() => homeProcesses(home).length === 0, 5_000, 'no process left').catch(() => {
    // Named below.
  });
  return homeProcesses(home).map((pid) => {
    try {
      return readFileSync(`/proc/${String(pid)}/cmdline`, 'latin1')
        .split('\0')
        .join(' ')
        .trim();
    } catch {
      return String(pid);
    }
  });
}

export function tmux(...args: string[]): number {
  return (
    spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, ...args], { env: home.env })
      .status ?? 1
  );
}

export const sessionAlive = (runId: string) => tmux('has-session', '-t', `orch-${runId}`) === 0;

export function startDaemon(): DaemonProcess {
  const daemon = spawnDaemon(['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

export async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  daemon.child.kill('SIGTERM');
  expect(await daemon.exited).toBe(0);
  daemons.splice(daemons.indexOf(daemon), 1);
}

export async function json<T>(
  parse: (value: unknown) => T,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) {
  const response = await h.call(method, url, payload);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return parse(response.json());
}

export const machine = (id: string) => json((v) => Machine.parse(v), 'GET', `/api/machines/${id}`);
export const run = (id: string) => json((v) => Run.parse(v), 'GET', `/api/runs/${id}`);
export const ticket = (number = 1) =>
  json((v) => TicketDetail.parse(v), 'GET', `/api/projects/WEB/tickets/${String(number)}`);

/** Waits until `check` holds, polling what the owner sees. */
export async function until(what: string, check: () => Promise<boolean>, timeoutMs = EFFECT_MS) {
  await waitFor(check, timeoutMs, what);
}

/** Add machine, then `orchestrator-daemon enroll` and `start`, as Help tells the owner. */
export async function enrolAndStart(): Promise<{ machineId: string; account: ClaudeAccount }> {
  const account = await json((v) => ClaudeAccount.parse(v), 'POST', '/api/accounts', {
    label: 'Personal',
    plan: 'pro',
    maxConcurrentRuns: 1,
  });
  const created = await json((v) => EnrollmentResponse.parse(v), 'POST', '/api/machines', {
    name: 'Laptop',
    accountId: account.id,
  });
  const enrolled = await runDaemon(['enroll', h.t.url, created.enrollment.code], home.env);
  expect(enrolled.stderr).toBe('');
  expect(enrolled.code).toBe(0);
  startDaemon();
  await until('the machine online', async () => (await machine(created.machine.id)).online);
  return { machineId: created.machine.id, account };
}

/** **Run now** on ticket 1, then the run started by the daemon (`running`). */
export async function runNow(): Promise<Run> {
  const created = await json((v) => Run.parse(v), 'POST', '/api/projects/WEB/tickets/1/run');
  await until('the run running', async () => (await run(created.id)).status === 'running');
  return run(created.id);
}

/**
 * CI passes for the commit the run submitted (lot 3 step G1a). The daemon pushed it to this
 * file's own Git server, not to the fake GitHub, so no pull request opens there: the wait is begun
 * and GitHub's answers for that commit are given here, then one check runs.
 */
export async function ciPasses(runId: string) {
  await until('the run waiting for CI', async () => {
    const current = await run(runId);
    return current.ci !== null && current.ci.waitingSince !== null;
  });
  const commit = (await run(runId)).ci?.commit ?? '';
  await h.t.db
    .update(schema.runs)
    .set({ ciWaitStartedAt: new Date() })
    .where(eq(schema.runs.id, runId));
  h.github.alter = (request, reply) => {
    if (request.path.includes(`/actions/runs?head_sha=${commit}`)) {
      return {
        status: 200,
        body: {
          total_count: 1,
          workflow_runs: [
            {
              id: 1,
              name: 'CI',
              event: 'pull_request',
              status: 'completed',
              conclusion: 'success',
              head_sha: commit,
              head_branch: BRANCH,
              html_url: 'https://github.com/octo-owner/bakery/actions/runs/1',
              pull_requests: [],
            },
          ],
        },
      };
    }
    if (request.path.includes(`/commits/${commit}/status`)) {
      return { status: 200, body: { state: 'pending', sha: commit, total_count: 0, statuses: [] } };
    }
    return reply;
  };
  try {
    await h.t.ciTick();
  } finally {
    h.github.alter = undefined;
  }
}

/**
 * Succeeded when CI passed, and ended on the machine: the daemon's end report, which adds the
 * branch, came after `run.stop` (its session reported closed).
 */
export async function endedSucceeded(id: string): Promise<boolean> {
  const current = await run(id);
  return current.status === 'succeeded' && !current.sessionAlive;
}

export async function runLog(id: string) {
  return json((v) => RunLogResponse.parse(v), 'GET', `/api/runs/${id}/log`);
}

/** A commit made by the agent with the `Bash` tool, as the worktree's own Git user. */
export const commit = (file: string, subject: string) => ({
  do: 'bash' as const,
  command: `printf '%s\\n' '${subject}' > ${file} && git add ${file} && git commit -q -m '${subject}'`,
});

export const report: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'contact.html holds the form.' },
    { index: 1, status: 'met', justification: 'The address field has type email.' },
  ],
  tests: { paths: [], justification: 'A static page with no test setup yet.' },
  docs: { paths: [], justification: 'Nothing for the owner to read.' },
  adrs: [],
  summary: 'Contact page with its form.',
};
export const submit = { do: 'mcp' as const, tool: 'ticket_submit', arguments: report };

/** The messages the fake received, oldest first. */
export async function messages(): Promise<string[]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'message' ? [entry.text] : []));
}

/** Quality's summary in the scenarios' reviews. */
export const SUMMARY = 'The contact form and its link are right.';
/** The project's repository on the fake GitHub (lot 3 and lot 4 scenarios). */
export const bakery = () => h.github.repository('octo-owner', 'bakery');
