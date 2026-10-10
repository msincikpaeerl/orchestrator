import { schema } from '@orchestrator/db';
import {
  ApiError,
  Run,
  type DodReport,
  type RunRefusal,
  type RunStart,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import {
  CHANGED_FILES,
  RunHarness,
  cleanWorkspace,
  eventually,
  state,
} from './run-harness.js';

// **Start review** (04, sections 2 and 3.2; owner's answers 1, 2a and 4, lot 3 step H1): a
// `review` run with the `quality` profile on any machine, for the commit CI checked, read again
// on GitHub (the fake) before any session; its first message's CI sentences; its refusals.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
  await h.stop();
});

const REPORT: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'ContactForm renders the form' },
    { index: 1, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

const MINUTE = 60_000;
let clock = new Date('2026-10-10T10:00:00.000Z');
const BRANCH = 't/1-contact-form';

/**
 * A ticket in review: implemented, submitted, its pull request opened and CI passed (or, with
 * `none`, "No CI found" after Wait for CI to start). Returns the machine and the commit CI checked.
 */
async function inReview(
  ci: 'success' | 'none' = 'success',
  options: { workflows?: boolean } = {},
) {
  clock = new Date('2026-10-10T10:00:00.000Z');
  await h.start({ now: () => clock, ci });
  await h.createTicket();
  const machine = await h.machine();
  const { runId, runToken } = await h.running(machine.daemon);
  const listed = options.workflows ? [...CHANGED_FILES, '.github/workflows/ci.yml'] : CHANGED_FILES;
  const answer = await h.tool(
    machine.daemon,
    runToken,
    'ticket_submit',
    REPORT,
    cleanWorkspace({ changedFiles: { listed, count: listed.length } }),
  );
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  if (ci === 'none') {
    await h.report(machine.daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the wait begun', async () => {
      expect((await h.run(runId)).ci?.since).toBeTruthy();
    });
    clock = new Date(clock.getTime() + 6 * MINUTE);
    await h.t.ciTick();
    await h.report(machine.daemon, state(runId, { state: 'ended', reason: 'submitted' }));
  } else {
    await h.ciPasses(machine.daemon, runId);
  }
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  const commit = h.lastPushed ?? '';
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  return { ...machine, implementRunId: runId, commit };
}

function startReview() {
  return h.call('POST', '/api/projects/WEB/tickets/1/review');
}

async function started(daemon: ScriptedDaemon) {
  const response = await startReview();
  expect(response.statusCode, response.body).toBe(201);
  const run = Run.parse(response.json());
  const start = await daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === run.id,
    'run.start of the review',
  );
  return { run, start };
}

async function refused(): Promise<RunRefusal> {
  const response = await startReview();
  expect(response.statusCode, response.body).toBe(409);
  const { error } = ApiError.parse(response.json());
  expect(error.code).toBe('run_not_possible');
  if (!error.runRefusal) throw new Error('no runRefusal');
  return error.runRefusal;
}

describe('Start review', () => {
  it('starts a review run with Quality for the commit CI checked, leaving the ticket in review', async () => {
    const { daemon, commit } = await inReview();
    const { run, start } = await started(daemon);

    expect(run.purpose).toBe('review');
    expect(start.payload).toMatchObject({
      purpose: 'review',
      reviewCommit: commit,
      repository: { ticketBranch: BRANCH, baseBranch: 'main' },
      profile: { key: 'quality', model: 'sonnet' },
    });
    // Its tools (answer 1): the review tools, never ticket_submit.
    expect(start.payload.mcpTools).toEqual(
      expect.arrayContaining(['review_approve', 'review_request_changes', 'ticket_ask']),
    );
    expect(start.payload.mcpTools).not.toContain('ticket_submit');
    expect(start.payload.profile.allowedTools).not.toContain('Edit');
    expect(start.payload.profile.instructions).toContain('# Your role: Quality');
    // Its first message (template review) and its nudge.
    const prompt = start.payload.initialPrompt;
    expect(prompt).toContain('Review ticket WEB-1 of the project Bakery website');
    expect(prompt).toContain(`Your worktree holds commit ${commit}, the head of pull request #1`);
    expect(prompt).toContain(`CI passed on GitHub for commit ${commit}.`);
    expect(prompt).toContain('CI already ran on GitHub: do not run the test suite again');
    expect(prompt).toContain('Adds the contact form.');
    expect(prompt).toContain('- [1] met: Tested in contact.test.ts');
    expect(start.payload.nudgeMessage).toContain('`review_approve`, `review_request_changes`');

    // Started like any run; the ticket stays in review (04, section 2).
    daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
    await eventually('dispatched', async () => {
      expect((await h.run(run.id)).status).toBe('dispatched');
    });
    const ticket = await h.ticket();
    expect(ticket.status).toBe('in_review');
    // The CI line stays on the work reviewed while the review runs.
    expect(ticket.ci?.outcome).toMatchObject({ kind: 'passed', commit });
    expect((await h.events('run.created')).at(-1)?.payload).toMatchObject({
      purpose: 'review',
      profile: 'quality',
      ticket: 'WEB-1',
    });
  });

  it('with No CI found, tells Quality nothing tested the work and to run the tests itself', async () => {
    const { daemon, commit } = await inReview('none');
    const { start } = await started(daemon);
    const prompt = start.payload.initialPrompt;
    expect(prompt).toContain(
      `No CI ran on GitHub for commit ${commit}: nothing appeared within Wait for CI to start after the pull request opened.`,
    );
    expect(prompt).toContain("run the project's tests and build yourself");
    expect(prompt).not.toContain('CI already ran on GitHub');
  });

  it('with No CI found and workflow files changed, says both in one sentence', async () => {
    const { daemon, commit } = await inReview('none', { workflows: true });
    const { start } = await started(daemon);
    expect(start.payload.initialPrompt).toContain(
      `No CI found for commit ${commit}, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read those changes first.`,
    );
  });

  it('after Check CI again accepted the work, says CI passed and never that it failed', async () => {
    const { daemon, commit, implementRunId } = await inReview();
    // As Check CI again leaves it (lot 3 step G2c): the run failed, the work accepted later.
    await h.t.db
      .update(schema.runs)
      .set({
        status: 'failed',
        failureReason: 'ci_timeout',
        ciAcceptedLater: { at: clock.toISOString(), state: 'passed', attemptTakenBack: false },
      })
      .where(eq(schema.runs.id, implementRunId));
    const { start } = await started(daemon);
    const prompt = start.payload.initialPrompt;
    expect(prompt).toContain(
      `CI passed on GitHub for commit ${commit}; the owner had it read again after the agent's run ended, and the work was accepted then.`,
    );
    expect(prompt.split('# WEB-1')[0]).not.toMatch(/fail|did not finish/i);
  });

  describe('refuses, starting no session', () => {
    it('a ticket not in review', async () => {
      await h.start();
      await h.createTicket();
      await h.machine();
      expect(await refused()).toEqual({ reason: 'ticket_not_in_review', status: 'todo' });
    });

    it('a ticket without a pull request (left in review by 0.3.0)', async () => {
      const { daemon } = await inReview();
      await h.t.db.update(schema.tickets).set({ pullRequestNumber: null, pullRequestUrl: null });
      expect(await refused()).toEqual({ reason: 'no_pull_request' });
      expect(daemon.received.filter((m) => m.type === 'run.start')).toHaveLength(1);
    });

    it('a second review while one is active', async () => {
      const { daemon } = await inReview();
      await started(daemon);
      expect(await refused()).toEqual({ reason: 'review_active' });
    });

    it("a pull request whose head on GitHub is not the commit CI checked", async () => {
      const { daemon, commit } = await inReview();
      const repo = h.github.repository('octo-owner', 'bakery');
      const head = h.github.commit(repo, BRANCH, { 'src/by-hand.ts': 'export {};\n' }, 'By hand');
      expect(await refused()).toEqual({ reason: 'review_head_moved', commit, head });
      expect(daemon.received.filter((m) => m.type === 'run.start')).toHaveLength(1);
    });

    it('GitHub unreachable: try again', async () => {
      const { daemon } = await inReview();
      h.github.override = (request) =>
        request.path.includes('/pulls/') ? { status: 503, body: { message: 'down' } } : undefined;
      expect(await refused()).toMatchObject({ reason: 'github_problem' });
      expect(daemon.received.filter((m) => m.type === 'run.start')).toHaveLength(1);
    });
  });
});
