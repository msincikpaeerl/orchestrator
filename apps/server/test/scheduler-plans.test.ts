import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  QueueResponse,
  RequestDetail,
  type DodReport,
  type QueueCandidate,
  type RunQuotaLimited,
  type RunResume,
  type RunStart,
} from '@orchestrator/protocol';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, cleanWorkspace, eventually, state } from './run-harness.js';

// The scheduler's `plan` candidate (07, section 3; lot 5 step E2b, owner's answers 10 to 12 of
// step E2 and 1 to 6 of E2b): a request planned with no owner action, its place in the order, its
// failures and Try again, the owner's later answer in the next run's first message, and a paused
// planning run's resume. The real application, scripted daemons; the tests run the ticks.

const h = new RunHarness();
let at = new Date('2026-11-02T10:00:00Z');
const clock = () => at;

afterEach(async () => {
  await h.stop();
  at = new Date('2026-11-02T10:00:00Z');
});

const SCHEDULER_LINE =
  'Started by the scheduler: the Orchestrator started this run by itself, not the owner.';

const PLAN = {
  summary: 'A contact form.',
  tickets: [{ key: 'contact', type: 'feature', title: 'Contact form' }],
};

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  expect(result.locked).toBe(true);
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

async function queue(): Promise<QueueCandidate[]> {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  return QueueResponse.parse(response.json()).candidates;
}

async function submit(project: string | null = 'WEB', body = 'A contact form on the home page.') {
  const created = await h.call('POST', '/api/requests', { body, project });
  expect(created.statusCode, created.body).toBe(201);
}

async function request(number = 1): Promise<RequestDetail> {
  const response = await h.call('GET', `/api/requests/${String(number)}`);
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

/** The request's latest planning run. */
async function latestRun(number = 1) {
  const [row] = await h.t.db
    .select({ run: schema.runs })
    .from(schema.runs)
    .innerJoin(schema.requests, eq(schema.requests.id, schema.runs.requestId))
    .where(eq(schema.requests.number, number))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!row) throw new Error(`request ${String(number)} has no run`);
  return row.run;
}

function startOf(daemon: ScriptedDaemon, runId: string): Promise<RunStart> {
  return daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === runId,
    'run.start',
  );
}

/** The run the loop started, acknowledged and working: its token and `run.start`. */
async function working(daemon: ScriptedDaemon, runId: string) {
  return h.working(daemon, runId);
}

async function crash(daemon: ScriptedDaemon, runId: string) {
  await h.report(daemon, state(runId, { state: 'ended', reason: 'crashed' }));
  await eventually('the run failed', async () => {
    expect((await h.run(runId)).status).toBe('failed');
  });
}

describe('a request planned with no owner action (answers 10 and 11)', () => {
  it('starts the Project Manager on the request, saying the scheduler started it, until its plan', async () => {
    await h.start();
    await submit();
    const { daemon } = await h.machine();

    expect(await queue()).toMatchObject([
      {
        kind: 'plan',
        ticket: null,
        request: { number: 1, line: 'A contact form on the home page.', projectKey: 'WEB' },
        reason: null,
        machine: { name: 'Laptop' },
        afterFailure: false,
      },
    ]);
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    expect(run).toMatchObject({
      purpose: 'plan',
      attempt: 1,
      branchName: null,
      baseBranch: 'main',
    });

    const start = await startOf(daemon, run.id);
    expect(start.payload).toMatchObject({
      purpose: 'plan',
      subject: { kind: 'request' },
      repository: { owner: 'octo-owner', name: 'bakery', baseBranch: 'main' },
      profile: { key: 'pm' },
    });
    expect(start.payload.repository?.ticketBranch).toBeUndefined();
    expect(start.payload.mcpTools).toContain('plan_propose');
    expect(
      start.payload.initialPrompt.startsWith(`${SCHEDULER_LINE}\n\nPlan request 1 for the project`),
    ).toBe(true);
    expect(start.payload.initialPrompt).toContain('This is attempt 1 at this request.');
    expect(start.payload.initialPrompt).toContain('A contact form on the home page.');

    const detail = await request();
    expect(detail.status).toBe('planning');
    expect(detail.comments.at(-1)).toMatchObject({
      author: 'system',
      body: 'Started by the scheduler: planning attempt 1 on machine Laptop.',
    });
    const [created] = await h.events('run.created');
    expect(created).toMatchObject({
      actor: 'system',
      payload: { ticket: 'Request 1', purpose: 'plan', profile: 'pm', attempt: 1 },
    });
    const dispatched = (await h.events('run.status_changed')).find(
      (event) => (event.payload as { to: string }).to === 'dispatched',
    );
    expect(dispatched).toMatchObject({ payload: { cause: 'scheduler', ticket: 'Request 1' } });
    expect((await h.events('request.status_changed')).at(-1)?.payload).toMatchObject({
      from: 'open',
      to: 'planning',
      cause: 'run_started',
      runId: run.id,
    });

    // One planning run at a time: the request is no candidate while it plans.
    expect(await tick()).toEqual([]);
    expect(await queue()).toEqual([]);
    const { runToken } = await working(daemon, run.id);
    await h.ok(daemon, runToken, 'plan_propose', PLAN);
    await h.report(daemon, state(run.id, { state: 'ended', reason: 'submitted' }));
    expect((await request()).status).toBe('plan_proposed');
    expect(await tick()).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("gives a new project's run no repository, and serves its request as its own project", async () => {
    await h.start();
    await submit(null, 'A bakery website.');
    const { daemon } = await h.machine();
    expect(await queue()).toMatchObject([
      { kind: 'plan', request: { number: 1, projectKey: null }, reason: null },
    ]);
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    expect(run.projectId).toBeNull();
    const start = await startOf(daemon, run.id);
    expect(start.payload.repository).toBeUndefined();
    expect(start.payload.initialPrompt).toContain('Plan request 1 for a new project');
  });

  it('asks a question, gets the answer in the same run, then proposes the plan', async () => {
    await h.start();
    await submit();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    const { runToken } = await working(daemon, run.id);
    await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    await h.report(daemon, state(run.id, { state: 'waiting_human' }));
    const answered = await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    expect(answered.statusCode, answered.body).toBe(200);
    await eventually('the answer sent to the run', () => {
      expect(
        daemon.received.some(
          (message) =>
            message.type === 'run.input' &&
            message.payload.runId === run.id &&
            message.payload.text.includes('The home page.'),
        ),
      ).toBe(true);
    });
    // Waiting for the answer, the request was no candidate; nothing else started.
    expect(await tick()).toEqual([]);
    await h.report(daemon, state(run.id, { state: 'working' }));
    await h.ok(daemon, runToken, 'plan_propose', PLAN);
    await h.report(daemon, state(run.id, { state: 'ended', reason: 'submitted' }));
    expect((await request()).status).toBe('plan_proposed');
  });
});

describe("a planning run's failures (answers 4 and 6 of step E2)", () => {
  it('starts it again behind the others, stops it at the limit, and Try again starts the next', async () => {
    await h.start({ settings: { maxFailedAttempts: 2 } });
    await submit();
    await submit('WEB', 'An opening hours page.');
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const first = await latestRun();
    await working(daemon, first.id);
    await crash(daemon, first.id);
    // A counted failure: behind request 2, whatever their age.
    expect((await queue()).map((each) => [each.request?.number, each.afterFailure])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(await tick()).toEqual(['plan Request 2 on Laptop']);
    const other = await latestRun(2);
    await working(daemon, other.id);
    await crash(daemon, other.id);
    await h.t.db
      .update(schema.requests)
      .set({ stopped: null })
      .where(eq(schema.requests.number, 2));

    // Request 2's count is its own: request 1 is next, as attempt 2.
    expect((await queue())[0]?.request?.number).toBe(1);
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const second = await latestRun();
    expect(second.attempt).toBe(2);
    expect((await startOf(daemon, second.id)).payload.initialPrompt).toContain(
      'This is attempt 2 at this request.',
    );
    await working(daemon, second.id);
    await crash(daemon, second.id);
    expect(await request()).toMatchObject({
      status: 'open',
      attemptCount: 2,
      stopped: { cause: 'failed_attempts', count: 2, limit: 2 },
    });

    // Stopped: it waits for Try again, and the loop starts nothing for it.
    const stopped = (await queue()).find((each) => each.request?.number === 1);
    expect(stopped?.reason).toEqual({ reason: 'planning_stopped' });
    await h.t.db
      .update(schema.requests)
      .set({ status: 'closed' })
      .where(eq(schema.requests.number, 2));
    expect(await tick()).toEqual([]);

    const tried = await h.call('POST', '/api/requests/1/try-again');
    expect(tried.statusCode, tried.body).toBe(200);
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    expect((await latestRun()).attempt).toBe(3);
  });

  it('leaves a machine out after a failure it caused, and says so once every machine is', async () => {
    await h.start();
    await submit();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    // The daemon refuses the start: its machine's failure, not counted.
    const start = await startOf(daemon, run.id);
    daemon.send({ type: 'ack', id: start.id, payload: { ok: false, message: 'stopping' } });
    await eventually('the run cancelled', async () => {
      expect((await h.run(run.id)).status).toBe('cancelled');
    });
    expect(await request()).toMatchObject({ status: 'open', attemptCount: 0 });
    expect(await tick()).toEqual([]);
    expect((await queue())[0]?.reason).toMatchObject({
      reason: 'no_machine',
      machines: [{ machine: { name: 'Laptop' }, unavailable: { why: 'left_out' } }],
    });
  });
});

describe('the order (answer 10 of step E2)', () => {
  it('puts a plan after reviews and fixes, before implement candidates', async () => {
    await h.start();
    await h.createTicket({ title: 'Contact form' });
    const { daemon } = await h.machine('Laptop', 1);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const [implement] = await h.t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.purpose, 'implement'));
    if (!implement) throw new Error('no implement run');
    const { runToken } = await h.working(daemon, implement.id);
    const report: DodReport = {
      criteria: [
        { number: 1, status: 'met', justification: 'ContactForm renders the form' },
        { number: 2, status: 'met', justification: 'Tested in contact.test.ts' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: ['docs/user/contact.md'], justification: null },
      adrs: [],
      summary: 'Adds the contact form.',
    };
    const answer = await h.tool(daemon, runToken, 'ticket_submit', report, cleanWorkspace());
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await h.ciPasses(daemon, implement.id);
    await eventually('the ticket in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });

    // The newer request goes before the older implement candidate.
    await h.createTicket({ title: 'Opening hours', priority: 'high' });
    await submit();
    expect(
      (await queue()).map((each) =>
        each.ticket === null
          ? `${each.kind} Request ${String(each.request?.number)}`
          : `${each.kind} WEB-${String(each.ticket.number)}`,
      ),
    ).toEqual(['review WEB-1', 'plan Request 1', 'implement WEB-2']);
    expect(await tick()).toEqual(['review WEB-1 on Laptop']);
  });
});

describe("the owner's later answer (answer 8 of step E2)", () => {
  it("gives an answer to an ended run's question in the next run's first message", async () => {
    await h.start();
    await submit();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const first = await latestRun();
    const { runToken } = await working(daemon, first.id);
    await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    await crash(daemon, first.id);
    const answered = await h.call('POST', '/api/requests/1/answer', {
      body: 'Only the home page, in French.',
    });
    expect(answered.statusCode, answered.body).toBe(200);

    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const next = await latestRun();
    const prompt = (await startOf(daemon, next.id)).payload.initialPrompt;
    expect(prompt).toMatch(/### Agent Project Manager, question, .*\n\nWhich pages\?/);
    expect(prompt).toMatch(/### The owner, answer, .*\n\nOnly the home page, in French\./);
    expect(prompt.indexOf('Which pages?')).toBeLessThan(prompt.indexOf('Only the home page'));
  });
});

describe('a paused planning run (answers 4 and 5 of step E2b)', () => {
  it('is in Needs you and the queue, and the scheduler resumes it with the planning words', async () => {
    await h.start({ now: clock });
    await submit();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    await working(daemon, run.id);
    const limited: RunQuotaLimited = {
      type: 'run.quota_limited',
      id: randomUUID(),
      payload: {
        runId: run.id,
        kind: 'detected',
        resetsAt: null,
        evidence: {
          signal: 'stop_failure',
          error: 'rate_limit',
          message: "You've hit your weekly limit",
          statusLine: null,
        },
      },
    };
    expect(await daemon.request(limited)).toMatchObject({ payload: { ok: true } });
    await h.report(daemon, state(run.id, { state: 'quota_paused' }, false));
    expect((await h.run(run.id)).status).toBe('paused_quota');
    expect((await request()).status).toBe('planning');

    const response = await h.call('GET', '/api/needs-you');
    const item = NeedsYouResponse.parse(response.json()).items.find(
      (each) => each.type === 'run_paused',
    );
    expect(item).toMatchObject({
      ticket: null,
      request: { number: 1, line: 'A contact form on the home page.', project: { key: 'WEB' } },
      resume: { reason: 'account_limited' },
    });
    expect(await queue()).toMatchObject([
      { kind: 'resume', runId: run.id, ticket: null, request: { number: 1 } },
    ]);

    // The limit's fallback passed: the scheduler resumes it on its machine.
    at = new Date(at.getTime() + 2 * 60 * 60 * 1000);
    expect(await tick()).toEqual(['resume Request 1 on Laptop']);
    const resume = await daemon.find<RunResume>(
      (message) => message.type === 'run.resume' && message.payload.runId === run.id,
      'run.resume',
    );
    expect(resume.payload.message).toContain('Continue planning the request where you left off.');
    expect(resume.payload.message).toContain('`request_get`');
    daemon.send({ type: 'ack', id: resume.id, payload: { ok: true } });
    await h.report(daemon, state(run.id, { state: 'working' }));
    expect((await h.run(run.id)).status).toBe('running');
    const comments = await h.t.db
      .select()
      .from(schema.comments)
      .innerJoin(schema.requests, eq(schema.requests.id, schema.comments.requestId))
      .where(and(eq(schema.requests.number, 1), eq(schema.comments.author, 'system')))
      .orderBy(asc(schema.comments.createdAt));
    expect(comments).toHaveLength(1);
  });
});
