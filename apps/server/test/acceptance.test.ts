import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  startGitHttpServer,
  type GitHttpServer,
} from '@orchestrator/daemon/testing/git-http-server';
import { createRemote, gitIn } from '@orchestrator/daemon/testing/remote';
import {
  AccountListResponse,
  CheckCiAgainResponse,
  ClaudeAccount,
  NeedsYouResponse,
  EnrollmentResponse,
  Machine,
  Run,
  RunLogResponse,
  TicketDetail,
  type DodReport,
} from '@orchestrator/protocol';
import { schema } from '@orchestrator/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { timestamp } from '../src/agents/messages.js';
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
/** Lot 2's scenarios: the project's repository on a local Git server, not on the fake GitHub. */
let git: GitHttpServer | undefined;
/** The bare repository standing for the project on GitHub, in lot 2's scenarios. */
let remote: string;
let h: RunHarness;
const daemons: DaemonProcess[] = [];
/** How far the application's clock is ahead of the real one (scenario F). */
let ahead = 0;

beforeEach(async () => {
  ahead = 0;
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
  await git?.close();
  git = undefined;
  await home.remove();
  expect(left, 'processes of the test home still running').toEqual([]);
  // Nothing left of the test home, nor of the fake GitHub's repositories.
  expect(existsSync(home.root), home.root).toBe(false);
  if (githubRoot !== undefined) expect(existsSync(githubRoot), githubRoot).toBe(false);
  githubRoot = undefined;
});

/** The fake GitHub's folder of the test's harness, once started. */
let githubRoot: string | undefined;

async function startHarness(options: Parameters<RunHarness['start']>[0]) {
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

/**
 * CI passes for the commit the run submitted (lot 3 step G1a). The daemon pushed it to this
 * file's own Git server, not to the fake GitHub, so no pull request opens there: the wait is begun
 * and GitHub's answers for that commit are given here, then one check runs.
 */
async function ciPasses(runId: string) {
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
async function endedSucceeded(id: string): Promise<boolean> {
  const current = await run(id);
  return current.status === 'succeeded' && !current.sessionAlive;
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
  beforeEach(async () => {
    // The project's GitHub repository (RunHarness's `octo-owner/bakery`), served with the token.
    const remotes = join(home.root, 'remotes');
    remote = await createRemote(remotes, 'octo-owner', 'bakery', home.env);
    git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
    await startHarness({ gitBaseUrl: git.url });
  });

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
      expect(git?.requests.some((request) => request.authenticated)).toBe(true);

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
      await ciPasses(started.id);
      await until('the run succeeded and ended', () => endedSucceeded(started.id));
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
      // Pushed at the submission (lot 3 step D1), which the machine knows (step D2).
      expect(status.stdout).toMatch(
        new RegExp(
          `${BRANCH} {2}head ${(done.branch?.head ?? '').slice(0, 7)}\n {6}nothing that is not on GitHub`,
        ),
      );
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
      await ciPasses(started.id);
      await until('the run succeeded and ended', () => endedSucceeded(started.id));
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
      await ciPasses(first.id);
      await until('the first run succeeded and ended', () => endedSucceeded(first.id));
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
      await ciPasses(second.id);
      await until('the second run succeeded and ended', () => endedSucceeded(second.id));
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

  it(
    "a push refused as diverged; the next run merges GitHub's branch, its push is accepted and the item goes (lot 3 step F2)",
    async () => {
      const BRANCH_ON_GITHUB = `origin/${BRANCH}`;
      await fake.play({
        turns: [
          {
            steps: [
              commit('contact.html', 'Add the contact form'),
              // Waits while the test changes the branch on GitHub, as Update branch would.
              {
                do: 'bash',
                command: 'touch running; while [ ! -e go ]; do sleep 0.1; done; rm go running',
              },
              submit,
              { do: 'text', text: 'The push was refused: ending my turn.' },
            ],
          },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const first = await runNow();
      const worktree = join(home.paths.home, 'worktrees', first.id);
      await until('the agent waiting', async () =>
        (await readdir(worktree).catch((): string[] => [])).includes('running'),
      );

      // Someone adds a commit to the ticket's branch on GitHub: the machine's branch diverges.
      const elsewhere = await mkdtemp(join(home.root, 'elsewhere-'));
      gitIn(elsewhere, ['clone', '--quiet', remote, '.'], home.env);
      gitIn(elsewhere, ['checkout', '--quiet', '-b', BRANCH, 'origin/main'], home.env);
      await writeFile(join(elsewhere, 'notes.md'), 'Opening hours\n');
      gitIn(elsewhere, ['add', 'notes.md'], home.env);
      gitIn(elsewhere, ['commit', '--quiet', '-m', 'Add the opening hours'], home.env);
      gitIn(elsewhere, ['push', '--quiet', 'origin', BRANCH], home.env);
      await writeFile(join(worktree, 'go'), '');

      // Refused: the run ends push_failed, not counted, and Needs you says the branch diverged.
      await until('the first run failed', async () => (await run(first.id)).status === 'failed');
      expect((await run(first.id)).failureReason).toBe('push_failed');
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      const needsYou = () =>
        json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you').then((response) =>
          response.items.filter((item) => item.type === 'push_failed'),
        );
      expect(await needsYou()).toMatchObject([
        { reason: 'diverged', machine: { id: machineId, name: 'Laptop' } },
      ]);

      // The next run merges GitHub's branch first, as its first message says, then submits.
      await fake.play({
        turns: [
          {
            steps: [{ do: 'bash', command: `git merge --no-edit ${BRANCH_ON_GITHUB}` }, submit],
          },
        ],
      });
      const second = await runNow();
      expect(second.machine.id).toBe(machineId);
      await ciPasses(second.id);
      await until('the second run succeeded and ended', () => endedSucceeded(second.id));
      const sent = await messages();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain(`run \`git merge ${BRANCH_ON_GITHUB}\``);

      // Pushed: GitHub's branch is the machine's, with both commits, and the item is gone.
      const done = await ticket();
      expect(done.status).toBe('in_review');
      const onGitHub = gitIn(remote, ['rev-parse', `refs/heads/${BRANCH}`], home.env).trim();
      expect(done.branch?.head).toBe(onGitHub);
      const files = gitIn(remote, ['ls-tree', '--name-only', onGitHub], home.env).split('\n');
      expect(files).toEqual(expect.arrayContaining(['contact.html', 'notes.md']));
      expect(await needsYou()).toEqual([]);
    },
    TIMEOUT,
  );
});

// The lot 3 acceptance scenarios (lot 3 plan, step M): the same real server, daemon, tmux and fake
// `claude`, with the project's repository on the fake GitHub, which serves its Git too. The pull
// request, CI, Quality's review and the merge happen there; the owner's merge is the fake's
// control, as on GitHub's site. No check of CI or of the pull requests starts by itself in tests:
// each GitHub check interval is one tick (`ciTick`).

const SUMMARY = 'The contact form and its link are right.';
const BROKEN_LINK = 'docs/user/contact.md: link to docs/user/faq.md not found';

const bakery = () => h.github.repository('octo-owner', 'bakery');
const pull = (number = 1) => h.github.pullRequest(bakery(), number);

/** The local ticket branch's head in the machine's bare clone; null when it has none. */
function localHead(branch: string): string | null {
  const bare = join(home.paths.home, 'repos', 'octo-owner', 'bakery.git');
  try {
    return gitIn(
      bare,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      home.env,
    ).trim();
  } catch {
    return null;
  }
}

/** The run's wait for CI begun for the commit the pull request now has: that commit. */
async function waitingForCi(runId: string): Promise<string> {
  await until('the run waiting for CI on the pull request', async () => {
    const current = await run(runId);
    return (
      h.github.branches(bakery()).has(BRANCH) &&
      current.ci?.waitingSince != null &&
      current.ci.commit === pull().headSha
    );
  });
  const commit = pull().headSha;
  await until('CI started on GitHub', () =>
    Promise.resolve(h.github.runs(bakery(), commit).length > 0),
  );
  return commit;
}

/** The workflow runs of `commit` on GitHub finish: passed, or with the link check failing. */
function ciFinishes(commit: string, outcome: 'success' | 'failure') {
  for (const workflow of h.github.runs(bakery(), commit)) {
    h.github.completeRun(
      workflow,
      outcome === 'success'
        ? []
        : [{ job: 'docs-links', step: 'Check documentation links', log: BROKEN_LINK }],
    );
  }
}

/** An implement or fix run submitted, CI passing on GitHub: the run ends and the ticket in review. */
async function passesCi(runId: string) {
  ciFinishes(await waitingForCi(runId), 'success');
  await h.t.ciTick();
  await until('the run succeeded and ended', () => endedSucceeded(runId));
  expect((await ticket()).status).toBe('in_review');
}

/** An owner's action on ticket 1 from the ticket page. */
const act = (action: string, payload?: object) =>
  json((v) => TicketDetail.parse(v), 'POST', `/api/projects/WEB/tickets/1/${action}`, payload);

/** The owner merges on GitHub; GitHub's time of the merge. */
function mergeOnGitHub(method: 'merge' | 'squash') {
  h.github.mergePullRequest(bakery(), 1, method);
  return new Date(pull().mergedAt ?? '');
}

function comments(detail: TicketDetail) {
  return detail.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

/**
 * After the merge: the ticket `done` by the merge watch (not by **Mark as done manually**), with
 * its `system` comment ending in `checks`, the ticket branch deleted on GitHub, then on the
 * machine by `branch.delete` (sent once GitHub's is deleted, in that check or a later one).
 * `head` is the pull request's merged head. Called before the check that finds the merge.
 */
async function doneAfterMerge(mergedAt: Date, head: string, checks: string) {
  // Until then, the machine keeps the branch where the runs left it.
  expect(localHead(BRANCH)).toBe(head);
  await h.t.ciTick();
  const done = await ticket();
  expect(done.status).toBe('done');
  expect(done.pullRequest.opened).toMatchObject({ number: 1, state: 'merged' });
  expect(comments(done).at(-1)).toMatchObject({
    author: 'system',
    kind: 'status_change',
    body: `Pull request #1 was merged on GitHub at ${timestamp(mergedAt)} (head ${head.slice(0, 7)}). ${checks}`,
  });
  expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
    from: 'awaiting_merge',
    to: 'done',
    action: 'pull_request_merged',
  });

  // GitHub's branch deleted in the same check: no run of the ticket was still ending.
  expect(h.github.branches(bakery()).has(BRANCH)).toBe(false);
  expect(done.branchCleanUp).toMatchObject({ branch: BRANCH, state: 'deleted', mergedHead: head });

  // The machine's branch, deleted by the daemon when the server asks (that check or a next one).
  await until('the local branch deleted', async () => {
    await h.t.ciTick();
    return (await ticket()).branchCleanUp?.machines[0]?.state === 'deleted';
  });
  expect(localHead(BRANCH)).toBeNull();
  expect((await h.events('ticket.machine_branch_deleted')).map((e) => e.payload)).toMatchObject([
    { branch: BRANCH },
  ]);
  // What `orchestrator-daemon status` shows the owner: no ticket branch left on the machine.
  const status = await runDaemon(['status'], home.env);
  expect(status.code).toBe(0);
  expect(status.stdout).not.toContain(BRANCH);
  // Nor any worktree of the ticket's runs, nor their run folders.
  expect(await readdir(join(home.paths.home, 'worktrees')).catch(() => [])).toEqual([]);
  expect(await readdir(join(home.paths.home, 'runs')).catch(() => [])).toEqual([]);
}

describe('lot 3 acceptance scenarios, real server and daemon, fake GitHub', () => {
  beforeEach(async () => {
    // CI on GitHub finishes only when a test says so.
    await startHarness({
      gitOnFakeGitHub: true,
      ci: 'queued',
      now: () => new Date(Date.now() + ahead),
    });
  });

  it(
    'D: implement, push, pull request, CI failing once then fixed, Start review, approved, merged on GitHub, done and cleaned up',
    async () => {
      await fake.play({
        turns: [
          { steps: [commit('contact.html', 'Add the contact form'), submit] },
          // The CI result message: the agent fixes the link and submits again.
          { steps: [commit('faq.md', 'Add the FAQ page'), submit] },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();

      // Pushed by the daemon to GitHub, and the pull request opened by the server.
      const first = await waitingForCi(started.id);
      expect(pull()).toMatchObject({ state: 'open', head: BRANCH, base: 'main' });
      // Git asks first without the credential, as for any push, then with the server's token.
      expect(
        h.github.gitRequests.some(
          (request) =>
            request.access === 'push' && request.credentialSent && request.outcome === 'served',
        ),
      ).toBe(true);

      // CI fails once: the result reaches the live session, which fixes it in a second commit.
      ciFinishes(first, 'failure');
      await h.t.ciTick();
      await until('the CI result in the session', async () => (await messages()).length === 2);
      expect((await messages())[1]).toContain(BROKEN_LINK);
      expect((await run(started.id)).status).not.toBe('failed');
      const second = await waitingForCi(started.id);
      expect(second).not.toBe(first);

      // CI passes for the second commit: the run ends, the ticket waits for the owner's check.
      await passesCi(started.id);
      const reviewed = await ticket();
      expect(reviewed).toMatchObject({ attemptCount: 0, branch: { head: second } });
      expect(reviewed.branch?.commits.map((c) => c.subject)).toEqual([
        'Add the FAQ page',
        'Add the contact form',
      ]);

      // Start review: Quality's own session approves the pull request's head.
      await fake.play({
        turns: [
          { steps: [{ do: 'mcp', tool: 'review_approve', arguments: { summary: SUMMARY } }] },
        ],
      });
      const review = await json((v) => Run.parse(v), 'POST', '/api/projects/WEB/tickets/1/review');
      expect(review.machine.id).toBe(machineId);
      await until('the review applied', async () => (await ticket()).status === 'awaiting_merge');
      await until('the review run ended', async () => {
        const current = await run(review.id);
        return current.status === 'succeeded' && !current.sessionAlive;
      });
      expect((await run(review.id)).purpose).toBe('review');
      // Quality's review also on GitHub, as a comment review on the pull request.
      await until('the review on GitHub', () => Promise.resolve(pull().reviews.length === 1));
      expect(JSON.stringify(pull().reviews[0])).toContain(SUMMARY);

      // The owner merges on GitHub with a merge commit; the next check finds it.
      const mergedAt = mergeOnGitHub('merge');
      await doneAfterMerge(
        mergedAt,
        second,
        'CI passed for this commit. Quality approved this commit.',
      );
      // Mark as done manually is refused: the merge watch already did it.
      const refused = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
        comment: 'Merged it myself.',
      });
      expect(refused.statusCode).toBe(409);
    },
    TIMEOUT,
  );

  it(
    'E: Skip review, Request changes from Awaiting merge, a fix_review run, squash merge, done and cleaned up',
    async () => {
      await fake.play({
        turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
      });
      await enrolAndStart();
      await h.createTicket();
      const first = await runNow();
      await passesCi(first.id);

      // The owner skips the review, then asks for a change while it waits for the merge.
      expect((await act('skip-review')).status).toBe('awaiting_merge');
      expect((await act('request-changes', { comment: CHANGES })).status).toBe('todo');

      // The next run fixes it on the same branch and pull request, with the owner's comment.
      await fake.play({
        turns: [{ steps: [commit('thanks.html', 'Add the thank-you message'), submit] }],
      });
      const fix = await runNow();
      expect(fix.purpose).toBe('fix_review');
      await passesCi(fix.id);
      const sent = await messages();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain(CHANGES);
      const head = pull().headSha;
      expect((await ticket()).branch?.head).toBe(head);
      expect(h.github.runs(bakery()).length).toBeGreaterThan(0);

      // Skip review again, and the owner squashes the pull request on GitHub: one new commit on
      // main, never the local branch's, so only the merged head can match it.
      expect((await act('skip-review')).status).toBe('awaiting_merge');
      const mergedAt = mergeOnGitHub('squash');
      expect(h.github.branches(bakery()).get('main')).not.toBe(head);
      await doneAfterMerge(
        mergedAt,
        head,
        `CI passed for this commit. You skipped the review of ${head.slice(0, 7)}.`,
      );
    },
    TIMEOUT,
  );

  it(
    'F: CI never finishing, ci_timeout, Check CI again after CI passed, in_review',
    async () => {
      await fake.play({
        turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
      });
      await enrolAndStart();
      await h.createTicket();
      const started = await runNow();
      const pushed = await waitingForCi(started.id);

      // CI never finishes within CI wait at submission (20 minutes by default).
      ahead = 21 * 60_000;
      await h.t.ciTick();
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'ci_timeout',
      });
      await until('the session closed', async () => !(await run(started.id)).sessionAlive);
      expect(sessionAlive(started.id)).toBe(false);
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      const ciItems = async () =>
        (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items.filter(
          (item) => item.type === 'ci_timeout',
        );
      expect(await ciItems()).toHaveLength(1);

      // CI passes later on GitHub; Check CI again from Needs you accepts the work.
      ciFinishes(pushed, 'success');
      const checked = await json(
        (v) => CheckCiAgainResponse.parse(v),
        'POST',
        '/api/projects/WEB/tickets/1/ci/check-again',
        { runId: started.id },
      );
      expect(checked).toMatchObject({ outcome: 'accepted', state: 'passed' });
      expect(await ticket()).toMatchObject({ status: 'in_review', branch: { head: pushed } });
      expect(await ciItems()).toEqual([]);
      // No new session: the machine ran one, and the fake received one message.
      expect(await messages()).toHaveLength(1);
    },
    TIMEOUT,
  );
});

// The lot 4 acceptance scenario of step D2b: the scheduler's loop (one `schedulerTick()` per
// pass) against the real daemon, a failure its machine caused, and what stops it looping.

describe('lot 4 acceptance scenario, real server and daemon, fake GitHub', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + ahead),
    });
  });

  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  /** The daemon stopped and started again a minute later, its `hello` reporting `claude`. */
  async function restart(daemon: DaemonProcess, machineId: string): Promise<DaemonProcess> {
    await stopDaemon(daemon);
    await until('the machine offline', async () => !(await machine(machineId)).online);
    ahead += 60_000;
    const next = startDaemon();
    await until('the machine online', async () => (await machine(machineId)).online);
    return next;
  }
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };
  const items = async () =>
    (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items.filter(
      (item) => item.type === 'machine_failures',
    );

  it(
    'G: Claude Code too old at a start, twice across a daemon restart: never in a loop, the item, then Run now',
    async () => {
      // Its `hello` reports a supported Claude Code; the one found at the start is too old.
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      await fake.play({ version: '2.1.100 (Claude Code)' });

      async function tooOld() {
        expect(await tick()).toEqual(['implement WEB-1']);
        const started = await latestRun();
        await until('the run failed', async () => (await run(started.id)).status === 'failed');
        expect((await run(started.id)).failureReason).toBe('claude_code_unsupported');
      }

      // First failure: the machine is unusable and left out; the loop starts nothing.
      await tooOld();
      for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });

      // Restarted, it connects again with a supported version: released, the loop starts it once.
      await fake.play({});
      let daemon = daemons[0];
      if (!daemon) throw new Error('no daemon');
      daemon = await restart(daemon, machineId);
      await fake.play({ version: '2.1.100 (Claude Code)' });
      await tooOld();

      // Second failure in a row on Laptop (Machine failures before asking you: 2): the item, and
      // nothing starts by itself, even after the machine connects again.
      expect(await items()).toMatchObject([
        { ticket: { number: 1 }, machine: { name: 'Laptop' }, limit: 2, failures: [{}, {}] },
      ]);
      await fake.play({});
      await restart(daemon, machineId);
      for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
      expect(await messages()).toEqual([]);

      // The owner's Run now starts it and removes the item.
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      const started = await runNow();
      expect(started.machine.id).toBe(machineId);
      expect(await items()).toEqual([]);
      await h.call('POST', `/api/runs/${started.id}/stop`);
      await until('the session closed', async () => !(await run(started.id)).sessionAlive);
    },
    TIMEOUT,
  );
});

describe('lot 4 step E: usage limits resumed by the scheduler, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + ahead),
    });
  });

  const MINUTE = 60_000;
  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  const now = () => Date.now() + ahead;
  /** The scenario of a turn reaching a limit: detected with no reset time, or suspected. */
  const weeklyLimit = {
    turns: [
      {
        steps: [{ do: 'text' as const, text: 'Working on the contact form.' }],
        end: {
          kind: 'stopFailure' as const,
          error: 'rate_limit',
          message: "You've hit your weekly limit",
        },
      },
    ],
  };
  const overloaded = {
    turns: [
      {
        steps: [{ do: 'text' as const, text: 'Working on the contact form.' }],
        end: {
          kind: 'stopFailure' as const,
          error: 'overloaded',
          message: 'API Error: Overloaded',
        },
      },
    ],
  };
  const finishing = {
    turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
  };

  async function pausedOn(runId: string, reason: 'usage_limit' | 'suspected_usage_limit') {
    await until('the run paused', async () => (await run(runId)).status === 'paused_quota');
    expect((await run(runId)).pauseReason).toBe(reason);
    await until('the session closed', () => Promise.resolve(!sessionAlive(runId)));
  }
  async function accountRow() {
    const [row] = await h.t.db.select().from(schema.claudeAccounts);
    if (!row) throw new Error('no account');
    return row;
  }
  async function runRow(id: string) {
    const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    if (!row) throw new Error('no run');
    return row;
  }
  /** The paused run's item in Needs you: why the scheduler does not resume it yet. */
  async function pausedItem() {
    const item = (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items.find(
      (each) => each.type === 'run_paused',
    );
    if (item?.type !== 'run_paused') throw new Error('no paused run in Needs you');
    return item;
  }
  /** Submitted: CI passes on the fake GitHub, the run ends and the ticket is in review. */
  async function finishes(runId: string) {
    await until('the run succeeded and ended', async () => {
      await h.t.ciTick();
      return endedSucceeded(runId);
    });
    expect(await ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
  }
  /** The `--resume` launches of the fake, each with the session of the first one. */
  async function resumes(): Promise<number> {
    const starts = (await fake.log()).flatMap((entry) =>
      entry.event === 'start' ? [entry.args] : [],
    );
    return starts.filter((args) => args.includes('--resume')).length;
  }
  /** The payloads of the events of `type`, oldest first. */
  const payloads = async (type: string) =>
    (await h.events(type)).map((event) => event.payload as Record<string, unknown>);
  const minutesUntil = (at: Date | string | null) =>
    Math.round((new Date(at ?? 0).getTime() - now()) / MINUTE);

  it(
    'a detected limit with a reset time: the scheduler resumes the run at that time, on its machine, and it finishes',
    async () => {
      // The status line's window full for 8 seconds gives the reset time.
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
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');
      await pausedOn(started.id, 'usage_limit');
      const limited = await accountRow();
      expect(limited).toMatchObject({ state: 'limited', limitedUntilEstimated: false });

      // Until the reset time: nothing, and Needs you says when it resumes.
      expect(await tick()).toEqual([]);
      expect((await pausedItem()).resume).toMatchObject({
        reason: 'account_limited',
        until: limited.limitedUntil?.toISOString(),
      });

      // At the reset time, the same session continues by itself and the agent finishes.
      await fake.play(finishing);
      ahead = (limited.limitedUntil?.getTime() ?? 0) - Date.now() + 1000;
      expect(await tick()).toEqual(['resume WEB-1']);
      expect((await run(started.id)).machine.id).toBe(machineId);
      await finishes(started.id);
      expect(await resumes()).toBe(1);
      expect(await messages()).toHaveLength(2);
      const resumed = (await h.events('run.status_changed')).find(
        (event) => (event.payload as Record<string, unknown>).cause === 'scheduler_resume',
      );
      expect(resumed).toMatchObject({
        actor: 'system',
        payload: { from: 'paused_quota', to: 'dispatched' },
      });
    },
    TIMEOUT,
  );

  it(
    'a limit with no reset time: resumed after 1 hour, then 2, then capped at Longest quota wait, with no failed attempt',
    async () => {
      const set = await h.call('PUT', '/api/settings/quotaFallbackMaxDelayMinutes', {
        value: 180,
      });
      expect(set.statusCode, set.body).toBe(200);
      await fake.play(weeklyLimit);
      await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');

      // Each resume reaches the limit again: the account's wait doubles, up to 180 minutes.
      for (const [index, wait] of [60, 120, 180, 180].entries()) {
        await pausedOn(started.id, 'usage_limit');
        await until('the run paused again', async () => (await resumes()) === index);
        const limited = await accountRow();
        expect(limited).toMatchObject({ limitedUntilEstimated: true, quotaWaitMinutes: wait });
        expect(minutesUntil(limited.limitedUntil)).toBe(wait);
        ahead += (wait - 1) * MINUTE;
        expect(await tick()).toEqual([]);
        ahead += 2 * MINUTE;
        if (wait === 180 && index === 3) await fake.play(finishing);
        expect(await tick()).toEqual(['resume WEB-1']);
      }
      await finishes(started.id);
      expect(await resumes()).toBe(4);
      expect((await payloads('account.limited')).map((p) => p.fallbackMinutes)).toEqual([
        60, 120, 180, 180,
      ]);
      // The resumed run ended its turn without a limit: the next wait is 1 hour again.
      expect((await accountRow()).quotaWaitMinutes).toBeNull();
      expect(await h.events('account.quota_wait_restarted')).toMatchObject([
        { payload: { minutes: 180 } },
      ]);
    },
    TIMEOUT,
  );

  it(
    'a suspected limit: the account unchanged, resumed after 1 hour, then 2, then 1 again once a turn ended without a limit',
    async () => {
      await fake.play(overloaded);
      await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');

      async function waits(minutes: number) {
        await pausedOn(started?.id ?? '', 'suspected_usage_limit');
        expect(await accountRow()).toMatchObject({ state: 'available', limitedUntil: null });
        const row = await runRow(started?.id ?? '');
        expect(row.quotaWaitMinutes).toBe(minutes);
        expect(minutesUntil(row.quotaResumeAt)).toBe(minutes);
        expect((await pausedItem()).resume).toMatchObject({ reason: 'quota_wait', minutes });
        ahead += (minutes - 1) * MINUTE;
        expect(await tick()).toEqual([]);
        ahead += 2 * MINUTE;
      }

      await waits(60);
      expect(await tick()).toEqual(['resume WEB-1']);
      await until('the second pause', async () => (await resumes()) === 1);
      await waits(120);
      // This resume works a turn without a limit (the agent stops; a reminder follows), then
      // reaches a suspected limit again: the wait starts afresh.
      await fake.play({
        turns: [
          { steps: [{ do: 'text', text: 'Looked at the form; continuing.' }] },
          ...overloaded.turns,
        ],
      });
      expect(await tick()).toEqual(['resume WEB-1']);
      await until('the third pause', async () => (await resumes()) === 2);
      await waits(60);
      await fake.play(finishing);
      expect(await tick()).toEqual(['resume WEB-1']);
      await finishes(started.id);
      const pauses = (await payloads('run.status_changed')).filter((p) => p.to === 'paused_quota');
      expect(pauses.map((p) => p.quotaWaitMinutes)).toEqual([60, 120, 60]);
      expect(await h.events('account.limited')).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'an account limited while two runs are paused: both resumed in order, within its maximum',
    async () => {
      await fake.play(weeklyLimit);
      const { account } = await enrolAndStart();
      const raised = await h.call('PATCH', `/api/accounts/${account.id}`, { maxConcurrentRuns: 2 });
      expect(raised.statusCode, raised.body).toBe(200);
      await h.createTicket();
      await h.createTicket({ title: 'Opening hours', priority: 'high' });
      expect(await tick()).toEqual(['implement WEB-2', 'implement WEB-1']);
      const rows = await h.t.db.select().from(schema.runs);
      const second = rows.find((row) => row.branchName.startsWith('t/2-'));
      const first = rows.find((row) => row.branchName.startsWith('t/1-'));
      if (!first || !second) throw new Error('two runs expected');
      await pausedOn(first.id, 'usage_limit');
      await pausedOn(second.id, 'usage_limit');
      // The same limit reported twice waits once, not double.
      expect(await accountRow()).toMatchObject({ quotaWaitMinutes: 60 });
      expect(await h.events('account.limited')).toHaveLength(1);

      // One place now: the high-priority ticket's run first, the other once a place is free.
      const lowered = await h.call('PATCH', `/api/accounts/${account.id}`, {
        maxConcurrentRuns: 1,
      });
      expect(lowered.statusCode, lowered.body).toBe(200);
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Continuing.' }] }] }, second.id);
      ahead += 61 * MINUTE;
      expect(await tick()).toEqual(['resume WEB-2']);
      expect(await tick()).toEqual([]);
      expect((await run(first.id)).status).toBe('paused_quota');
      // WEB-2 reaches a suspected limit: its place is free, WEB-1's run resumes.
      await fake.play(overloaded, second.id);
      await fake.play(finishing, first.id);
      await until(
        'WEB-2 paused again',
        async () => (await run(second.id)).status === 'paused_quota',
      );
      expect(await tick()).toEqual(['resume WEB-1']);
      await finishes(first.id);
      expect((await ticket(2)).attemptCount).toBe(0);
      await h.call('POST', `/api/runs/${second.id}/stop`);
    },
    TIMEOUT,
  );
});

describe('lot 4 step G: a machine offline during a run, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + ahead),
    });
  });

  const MINUTE = 60_000;
  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  /** The agent commits, says it got there, then works on for a minute (it is stopped first). */
  const committing = {
    turns: [
      {
        steps: [
          commit('contact.html', 'Add the contact form'),
          { do: 'bash' as const, command: 'touch working' },
          { do: 'sleep' as const, ms: 60_000 },
        ],
      },
    ],
  };
  const reviewing = {
    turns: [
      {
        steps: [
          { do: 'text' as const, text: 'Reviewing the contact form.' },
          { do: 'sleep' as const, ms: 60_000 },
        ],
      },
    ],
  };
  const working = (runId: string) =>
    until('the agent at work', async () =>
      (await readdir(join(home.paths.home, 'worktrees', runId)).catch((): string[] => [])).includes(
        'working',
      ),
    );
  const theDaemon = () => {
    const daemon = daemons[0];
    if (!daemon) throw new Error('no daemon');
    return daemon;
  };
  async function offline(machineId: string) {
    await stopDaemon(theDaemon());
    await until('the machine offline', async () => !(await machine(machineId)).online);
  }
  async function online(machineId: string) {
    startDaemon();
    await until('the machine online', async () => (await machine(machineId)).online);
  }
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };

  it(
    'back before Runs of an offline machine fail after, the run goes on; back after it, failed, its session stopped and its end kept',
    async () => {
      await fake.play(committing);
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();
      await working(started.id);

      // Offline 9 minutes: nothing fails, and the run goes on with the session it kept.
      await offline(machineId);
      ahead += 9 * MINUTE;
      expect(await tick()).toEqual([]);
      await online(machineId);
      expect((await run(started.id)).status).toBe('running');
      expect(sessionAlive(started.id)).toBe(true);

      // Offline 11 minutes: failed at the scheduler's check, not counted.
      await offline(machineId);
      ahead += 11 * MINUTE;
      expect(await tick()).toEqual([]);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      expect(sessionAlive(started.id)).toBe(true);

      // Back: the session is stopped (not active), its end push and branch report are kept.
      await online(machineId);
      await until('the session stopped', () => Promise.resolve(!sessionAlive(started.id)));
      await until('the end reported', async () => (await run(started.id)).branch.head !== null);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
        branch: { commits: [{ subject: 'Add the contact form' }] },
        push: { result: { status: 'pushed' } },
      });
      expect(h.github.branches(h.github.repository('octo-owner', 'bakery')).has(BRANCH)).toBe(true);

      // Laptop is released by its reconnection: the ticket starts again there.
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      expect(await tick()).toEqual(['implement WEB-1']);
      const next = await latestRun();
      expect(next.machineId).toBe(machineId);
      await h.call('POST', `/api/runs/${next.id}/stop`);
      await until('the session closed', async () => !(await run(next.id)).sessionAlive);
    },
    TIMEOUT,
  );

  it(
    'a daemon restarted without a run it had: the run fails at its hello, and starts again there',
    async () => {
      await fake.play(committing);
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();
      await working(started.id);

      // The daemon lost the run: its session, its record and its worktree are gone. (A record
      // lost alone, its worktree left, would make the next run's preparation fail: the daemon
      // leaves a worktree it has no record of as it is.)
      await offline(machineId);
      tmux('kill-session', '-t', `orch-${started.id}`);
      await rm(join(home.paths.home, 'runs', started.id), { recursive: true, force: true });
      const bare = join(home.paths.home, 'repos', 'octo-owner', 'bakery.git');
      const worktree = join(home.paths.home, 'worktrees', started.id);
      const removed = spawnSync(
        join(home.bin, 'git'),
        ['-C', bare, 'worktree', 'remove', '--force', worktree],
        { env: home.env },
      );
      expect(removed.status, removed.stderr.toString()).toBe(0);
      ahead += MINUTE;
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      await online(machineId);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      expect(await tick()).toEqual(['implement WEB-1']);
      const next = await latestRun();
      await until('the next run running', async () => (await run(next.id)).status === 'running');
      await h.call('POST', `/api/runs/${next.id}/stop`);
      await until('the session closed', async () => !(await run(next.id)).sessionAlive);
    },
    TIMEOUT,
  );

  it(
    'a review run on a machine offline too long: the ticket stays in review, "Review did not finish"',
    async () => {
      await fake.play({
        turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const built = await runNow();
      await until('the run succeeded and ended', async () => {
        await h.t.ciTick();
        return endedSucceeded(built.id);
      });
      await fake.play(reviewing);
      expect(await tick()).toEqual(['review WEB-1']);
      const review = await latestRun();
      await until('the review running', async () => (await run(review.id)).status === 'running');

      await offline(machineId);
      ahead += 11 * MINUTE;
      expect(await tick()).toEqual([]);
      expect(await run(review.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
      const items = (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items;
      expect(items.map((item) => item.type)).toContain('review_not_finished');

      await online(machineId);
      await until('the session stopped', () => Promise.resolve(!sessionAlive(review.id)));
      expect((await run(review.id)).status).toBe('failed');
      expect(await tick()).toEqual([]);
    },
    TIMEOUT,
  );
});
