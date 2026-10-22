import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDaemon } from '@orchestrator/daemon/testing';
import {
  startGitHttpServer,
  type GitHttpServer,
} from '@orchestrator/daemon/testing/git-http-server';
import { createRemote, gitIn } from '@orchestrator/daemon/testing/remote';
import {
  AccountListResponse,
  CheckCiAgainResponse,
  NeedsYouResponse,
  Run,
  TicketDetail,
} from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { timestamp } from '../src/agents/messages.js';
import { TOKEN } from './run-harness.js';
import {
  BRANCH,
  SUMMARY,
  TIMEOUT,
  acceptanceHooks,
  bakery,
  ciPasses,
  clock,
  commit,
  daemons,
  endedSucceeded,
  enrolAndStart,
  fake,
  h,
  home,
  json,
  machine,
  messages,
  report,
  run,
  runLog,
  runNow,
  sessionAlive,
  startDaemon,
  startHarness,
  stopDaemon,
  submit,
  ticket,
  until,
} from './acceptance-harness.js';

// The lot 2 and lot 3 acceptance scenarios (lot 2 plan, step M; lot 3 plan, step M), on the
// shared harness of `acceptance-harness.ts`; lot 4's are in `acceptance-lot4.test.ts`.

const QUESTION = 'Should the form ask for a phone number?';
const ANSWER = 'No phone number: name, e-mail address and message only.';
const CHANGES = 'Please add a "Thank you" message after sending.';
/** Lot 2's scenarios: the project's repository on a local Git server, not on the fake GitHub. */
let git: GitHttpServer | undefined;
/** The bare repository standing for the project on GitHub, in lot 2's scenarios. */
let remote: string;

acceptanceHooks();

describe('lot 2 acceptance scenario, real server and daemon', () => {
  beforeEach(async () => {
    // The project's GitHub repository (RunHarness's `octo-owner/bakery`), served with the token.
    const remotes = join(home.root, 'remotes');
    remote = await createRemote(remotes, 'octo-owner', 'bakery', home.env);
    git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
    await startHarness({ gitBaseUrl: git.url });
  });

  afterEach(async () => {
    await git?.close();
    git = undefined;
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

const BROKEN_LINK = 'docs/user/contact.md: link to docs/user/faq.md not found';

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
      now: () => new Date(Date.now() + clock.ahead),
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
      clock.ahead = 21 * 60_000;
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
