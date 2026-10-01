import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestHome,
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
  startGitHttpServer,
  type GitHttpServer,
} from '@orchestrator/daemon/testing/git-http-server';
import { createRemote } from '@orchestrator/daemon/testing/remote';
import {
  AccountListResponse,
  ClaudeAccount,
  EnrollmentResponse,
  Machine,
  Run,
  RunLogResponse,
  TicketDetail,
  type DodReport,
} from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHarness, TOKEN } from './run-harness.js';

// The lot 2 acceptance scenario end to end (lot 2 plan, step M): the real server, the real
// daemon process started from its sources as the owner types its commands, the host's tmux and
// Git, and the fake `claude` (working rule 10). The owner's side goes through the API; the
// project's repository is a local Git remote asking for the GitHub token. Every wait is for an
// effect the owner could see (the API, `orchestrator-daemon status`), with a deadline.

const TIMEOUT = 120_000;
/** Longest wait for one effect of the daemon (a fetch, a tmux session, a report). */
const EFFECT_MS = 30_000;
const BRANCH = 't/1-contact-form';
const QUESTION = 'Should the form ask for a phone number?';
const ANSWER = 'No phone number: name, e-mail address and message only.';
const CHANGES = 'Please add a "Thank you" message after sending.';

let home: TestHome;
let fake: FakeClaude;
let git: GitHttpServer;
let h: RunHarness;
const daemons: DaemonProcess[] = [];

beforeEach(async () => {
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
  // The project's GitHub repository (RunHarness's `octo-owner/bakery`), served with the token.
  const remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'octo-owner', 'bakery', home.env);
  git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
  h = new RunHarness();
  await h.start({ gitBaseUrl: git.url });
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  }
  tmux('kill-server');
  // Every process started for the test (daemon, tmux, the fake, hooks, relays) is gone before
  // its home folder is removed.
  await stopHomeProcesses(home);
  await h.stop();
  await git.close();
  await home.remove();
});

function tmux(...args: string[]): number {
  return (
    spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, ...args], { env: home.env })
      .status ?? 1
  );
}

const sessionAlive = (runId: string) => tmux('has-session', '-t', `orch-${runId}`) === 0;

function startDaemon(): DaemonProcess {
  const daemon = spawnDaemon(['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  daemon.child.kill('SIGTERM');
  expect(await daemon.exited).toBe(0);
  daemons.splice(daemons.indexOf(daemon), 1);
}

async function json<T>(
  parse: (value: unknown) => T,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) {
  const response = await h.call(method, url, payload);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return parse(response.json());
}

const machine = (id: string) => json((v) => Machine.parse(v), 'GET', `/api/machines/${id}`);
const run = (id: string) => json((v) => Run.parse(v), 'GET', `/api/runs/${id}`);
const ticket = (number = 1) =>
  json((v) => TicketDetail.parse(v), 'GET', `/api/projects/WEB/tickets/${String(number)}`);

/** Waits until `check` holds, polling what the owner sees. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = EFFECT_MS) {
  await waitFor(check, timeoutMs, what);
}

/** Add machine, then `orchestrator-daemon enroll` and `start`, as Help tells the owner. */
async function enrolAndStart(): Promise<{ machineId: string; account: ClaudeAccount }> {
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
async function runNow(): Promise<Run> {
  const created = await json((v) => Run.parse(v), 'POST', '/api/projects/WEB/tickets/1/run');
  await until('the run running', async () => (await run(created.id)).status === 'running');
  return run(created.id);
}

async function runLog(id: string) {
  return json((v) => RunLogResponse.parse(v), 'GET', `/api/runs/${id}/log`);
}

/** A commit made by the agent with the `Bash` tool, as the worktree's own Git user. */
const commit = (file: string, subject: string) => ({
  do: 'bash' as const,
  command: `printf '%s\\n' '${subject}' > ${file} && git add ${file} && git commit -q -m '${subject}'`,
});

const report: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'contact.html holds the form.' },
    { index: 1, status: 'met', justification: 'The address field has type email.' },
  ],
  tests: { paths: [], justification: 'A static page with no test setup yet.' },
  docs: { paths: [], justification: 'Nothing for the owner to read.' },
  adrs: [],
  summary: 'Contact page with its form.',
};
const submit = { do: 'mcp' as const, tool: 'ticket_submit', arguments: report };

/** The messages the fake received, oldest first. */
async function messages(): Promise<string[]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'message' ? [entry.text] : []));
}

describe('lot 2 acceptance scenario, real server and daemon', () => {
  it(
    'A: enrol, Run now, live log, a question answered, a ticket proposed, commits, submitted to in_review',
    async () => {
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'text', text: 'Reading the ticket and the README.' },
              { do: 'mcp', tool: 'ticket_ask', arguments: { question: QUESTION } },
              { do: 'text', text: 'Waiting for the answer.' },
            ],
          },
          {
            steps: [
              {
                do: 'mcp',
                tool: 'ticket_create',
                arguments: {
                  type: 'docs',
                  title: 'Explain the contact form in the README',
                  description: 'Found while building the form.',
                  acceptance_criteria: ['The README names the contact page'],
                  priority: 'low',
                },
              },
              commit('contact.html', 'Add the contact form'),
              submit,
              { do: 'text', text: 'Submitted.' },
            ],
          },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();

      // Run now, and the agent's first line in the live log.
      const started = await runNow();
      expect(started.machine.id).toBe(machineId);
      expect((await ticket()).status).toBe('in_progress');
      await until('the first log line', async () =>
        (await runLog(started.id)).entries.some(
          (entry) => entry.kind === 'agent_text' && entry.text.includes('Reading the ticket'),
        ),
      );
      // The fetch went through the daemon with the server's token, asked for that command only.
      expect(git.requests.some((request) => request.authenticated)).toBe(true);

      // The question, answered by the owner: the live session receives the answer.
      await until('the run waiting for the owner', async () => {
        const current = await run(started.id);
        return current.status === 'waiting_human';
      });
      expect((await ticket()).status).toBe('waiting_human');
      await json((v) => TicketDetail.parse(v), 'POST', '/api/projects/WEB/tickets/1/answer', {
        body: ANSWER,
      });
      await until('the answer in the session', async () =>
        (await messages()).some((text) => text.includes(ANSWER)),
      );

      // Submitted: the run succeeds and the ticket waits for the owner's check with its branch.
      await until('the run succeeded', async () => (await run(started.id)).status === 'succeeded');
      const done = await ticket();
      expect(done.status).toBe('in_review');
      expect(done.dodReport?.summary).toBe(report.summary);
      expect(done.branch).toMatchObject({
        name: BRANCH,
        machine: { id: machineId, name: 'Laptop' },
        commits: [{ subject: 'Add the contact form' }],
      });
      expect(done.branch?.head).toMatch(/^[0-9a-f]{40}$/);

      // The ticket the agent proposed, waiting for the owner's decision.
      const proposed = await ticket(2);
      expect(proposed).toMatchObject({
        status: 'proposed',
        title: 'Explain the contact form in the README',
      });

      // The same branch and commit, as `orchestrator-daemon status` shows them on the machine.
      const status = await runDaemon(['status'], home.env);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('octo-owner/bakery');
      expect(status.stdout).toMatch(
        new RegExp(`${BRANCH} {2}head ${(done.branch?.head ?? '').slice(0, 7)}`),
      );
      expect(status.stdout).toContain('Add the contact form');
      // The session is closed and nothing of the run is left running.
      expect(sessionAlive(started.id)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'B: a detected usage limit pauses the run and locks the account until the reset, then Resume finishes it',
    async () => {
      // The limit as the documentation gives it, with a status line window full for 8 seconds.
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'text', text: 'Starting on the contact form.' },
              { do: 'statusLine', fullForSeconds: 8 },
            ],
            end: {
              kind: 'stopFailure',
              error: 'rate_limit',
              message: "You've hit your session limit · resets 3:45pm",
            },
          },
        ],
      });
      const { account } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();

      await until('the run paused on the limit', async () => {
        const current = await run(started.id);
        return current.status === 'paused_quota';
      });
      const paused = await run(started.id);
      expect(paused.pauseReason).toBe('usage_limit');
      expect(paused.resumeAfter?.estimated).toBe(false);
      const limited = (
        await json((v) => AccountListResponse.parse(v), 'GET', '/api/accounts')
      ).accounts.find((candidate) => candidate.id === account.id);
      expect(limited).toMatchObject({ state: 'limited', limitedUntilEstimated: false });
      // The reset time is the status line's, not the message's "3:45pm".
      const resetAt = Date.parse(limited?.limitedUntil ?? '');
      expect(resetAt - Date.now()).toBeLessThan(10_000);
      // No session left open to continue by itself; no nudge was sent.
      await until('the session closed', () => Promise.resolve(!sessionAlive(started.id)));
      expect(await messages()).toHaveLength(1);

      // Resume is refused until the reset time.
      const early = await h.call('POST', `/api/runs/${started.id}/resume`);
      expect(early.statusCode, early.body).toBe(409);
      expect((await run(started.id)).status).toBe('paused_quota');

      // After it: the same Claude Code session is resumed, and the agent finishes.
      await fake.play({
        turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
      });
      await until('the reset time', () => Promise.resolve(Date.now() > resetAt + 500), 20_000);
      await json((v) => Run.parse(v), 'POST', `/api/runs/${started.id}/resume`);
      await until('the run succeeded', async () => (await run(started.id)).status === 'succeeded');
      expect((await ticket()).status).toBe('in_review');

      const starts = (await fake.log()).flatMap((entry) =>
        entry.event === 'start' ? [entry.args] : [],
      );
      expect(starts).toHaveLength(2);
      const resumed = starts[1] ?? [];
      const sessionId = resumed[resumed.indexOf('--resume') + 1] ?? '';
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // The resumed session is the first one: its transcript holds the first message.
      const projects = join(home.paths.claudeConfig, 'projects');
      const [folder] = await readdir(projects);
      const transcript = await readFile(join(projects, folder ?? '', `${sessionId}.jsonl`), 'utf8');
      expect(transcript).toContain('Starting on the contact form.');
      expect((await messages()).length).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'C: the daemon restarts during a run that then finishes; Request changes, and the next run reads the comment',
    async () => {
      // The agent works until the test lets it go on (a file it waits for in its worktree), so
      // the daemon is restarted while a tool call runs. The command first writes `running`: the
      // tool call is in the log before its PreToolUse hook has answered, and a hook finding no
      // daemon refuses the call (05, section 4.6), so only the command itself shows it runs.
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'text', text: 'Building the form.' },
              {
                do: 'bash',
                command: 'touch running; while [ ! -e go ]; do sleep 0.1; done; rm go running',
              },
              commit('contact.html', 'Add the contact form'),
              submit,
            ],
          },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const first = await runNow();
      const worktree = join(home.paths.home, 'worktrees', first.id);
      await until('the tool call running', async () =>
        (await readdir(worktree).catch((): string[] => [])).includes('running'),
      );

      // The daemon stops (as `systemctl --user restart` does) and starts again.
      const daemon = daemons[0];
      if (!daemon) throw new Error('no daemon');
      await stopDaemon(daemon);
      expect(sessionAlive(first.id)).toBe(true);
      await until('the machine offline', async () => !(await machine(machineId)).online);
      startDaemon();
      await until('the machine online again', async () => (await machine(machineId)).online);
      expect((await run(first.id)).status).toBe('running');
      expect(sessionAlive(first.id)).toBe(true);

      // The agent goes on: its tool calls reach the new daemon, and the run finishes.
      await writeFile(join(worktree, 'go'), '');
      await until(
        'the first run succeeded',
        async () => (await run(first.id)).status === 'succeeded',
      );
      expect((await ticket()).status).toBe('in_review');

      // Request changes, then Run now: the next run's first message holds the owner's comment.
      await json(
        (v) => TicketDetail.parse(v),
        'POST',
        '/api/projects/WEB/tickets/1/request-changes',
        {
          comment: CHANGES,
        },
      );
      const changed = await ticket();
      expect(changed.status).toBe('todo');
      expect(changed.attemptCount).toBe(0);
      await fake.play({
        turns: [{ steps: [commit('thanks.html', 'Add the thank-you message'), submit] }],
      });
      const second = await runNow();
      expect(second.id).not.toBe(first.id);
      await until(
        'the second run succeeded',
        async () => (await run(second.id)).status === 'succeeded',
      );
      const sent = await messages();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain(CHANGES);
      // The second run went on from the first run's branch.
      expect((await ticket()).branch?.commits.map((c) => c.subject)).toEqual([
        'Add the thank-you message',
        'Add the contact form',
      ]);
    },
    TIMEOUT,
  );
});
