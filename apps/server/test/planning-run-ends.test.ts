import { schema } from '@orchestrator/db';
import {
  ApiError,
  LiveRunsResponse,
  NeedsYouResponse,
  RequestDetail,
  Run,
  type NeedsYouItem,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requestMachineFailures } from '../src/requests/planning-end.js';
import { leftOutMachines } from '../src/tickets/holds.js';
import { startPlanningRun } from './planning-run.js';
import { RunHarness, state } from './run-harness.js';

// The failures of planning runs (lot 5 step E2a; 01 section 3.2; owner's answers 2 to 9): every
// end without a plan puts its request back to `open` with a `system` comment; a counted failure
// raises the request's count and stops it at **Failed attempts before asking you**, as the
// owner's **Stop run** does; **Try again** clears the stop. A question left by a run that ended
// waits for no one. The planning runs are the test helper's, played by a scripted daemon.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

/** Request 1 on WEB, and the machine Laptop. */
async function submitted(options: Parameters<RunHarness['start']>[0] = {}) {
  await h.start(options);
  const created = await h.call('POST', '/api/requests', {
    body: 'A contact form on the home page.',
    project: 'WEB',
  });
  expect(created.statusCode, created.body).toBe(201);
  return h.machine();
}

/** A planning run of request 1 on the machine, `running`. */
async function planning(machine: Awaited<ReturnType<typeof submitted>>) {
  const run = await startPlanningRun(h.t.db, { request: 1, machineId: machine.id });
  await h.report(machine.daemon, state(run.runId, { state: 'working' }));
  return run;
}

async function request(): Promise<RequestDetail> {
  const response = await h.call('GET', '/api/requests/1');
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

async function requestRow() {
  const [row] = await h.t.db.select().from(schema.requests).where(eq(schema.requests.number, 1));
  if (!row) throw new Error('no request');
  return row;
}

type StoppedItem = Extract<NeedsYouItem, { type: 'planning_stopped' }>;
type QuestionItem = Extract<NeedsYouItem, { type: 'request_question' }>;

async function items() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}
const stoppedItems = async () =>
  (await items()).filter((item): item is StoppedItem => item.type === 'planning_stopped');
const questionItems = async () =>
  (await items()).filter((item): item is QuestionItem => item.type === 'request_question');

const lastComment = async () => (await request()).comments.at(-1);

describe('a planning run that fails (owner answers 4 and 6)', () => {
  it('counts a crash on its request, with a system comment, the request open again', async () => {
    const machine = await submitted();
    const { runId } = await planning(machine);
    await h.report(machine.daemon, state(runId, { state: 'ended', reason: 'crashed' }));
    const detail = await request();
    expect(detail).toMatchObject({ status: 'open', attemptCount: 1, stopped: null, run: null });
    expect(await lastComment()).toMatchObject({
      author: 'system',
      body: 'Planning attempt 1 failed on machine Laptop: its Claude Code session stopped unexpectedly or never started. It counts as a failed attempt.',
    });
    expect(await stoppedItems()).toEqual([]);
  });

  it('stops the request at Failed attempts before asking you, until Try again', async () => {
    const machine = await submitted({ settings: { maxFailedAttempts: 2 } });
    const first = await planning(machine);
    await h.report(machine.daemon, state(first.runId, { state: 'ended', reason: 'crashed' }));
    const second = await planning(machine);
    // Its reminders used up without a plan: counted as the agent giving up (05, section 4.8).
    await h.report(
      machine.daemon,
      state(second.runId, { state: 'ended', reason: 'nudges_exhausted' }),
    );
    const detail = await request();
    expect(detail).toMatchObject({
      status: 'open',
      attemptCount: 2,
      stopped: { cause: 'failed_attempts', count: 2, limit: 2 },
    });
    expect((await lastComment())?.body).toBe(
      'Planning attempt 1 failed on machine Laptop: the agent gave up. It counts as a failed attempt: 2 failed attempts, as many as Failed attempts before asking you allows (2), so the request is stopped. Use Try again to let the Project Manager plan it again.',
    );
    expect((await h.events('request.stopped')).map((event) => event.payload)).toEqual([
      {
        request: 1,
        project: 'WEB',
        cause: 'failed_attempts',
        count: 2,
        limit: 2,
        runId: second.runId,
      },
    ]);
    const [item, ...others] = await stoppedItems();
    expect(others).toEqual([]);
    expect(item).toMatchObject({
      request: { number: 1, line: 'A contact form on the home page.', project: { key: 'WEB' } },
      stop: { cause: 'failed_attempts', count: 2, limit: 2 },
    });
    expect(item?.since).toBe(detail.stopped?.at);

    const tried = await h.call('POST', '/api/requests/1/try-again');
    expect(tried.statusCode, tried.body).toBe(200);
    expect(RequestDetail.parse(tried.json())).toMatchObject({ attemptCount: 0, stopped: null });
    expect(await lastComment()).toMatchObject({
      author: 'owner',
      kind: 'status_change',
      body: 'The owner used Try again: the request was stopped after 2 failed planning attempts (Failed attempts before asking you: 2). Its failed attempts count from 0 again.',
    });
    expect((await h.events('request.tried_again')).at(-1)?.payload).toMatchObject({
      request: 1,
      cause: 'failed_attempts',
    });
    expect(await stoppedItems()).toEqual([]);
    const again = await h.call('POST', '/api/requests/1/try-again');
    expect(again.statusCode).toBe(409);
    expect(ApiError.parse(again.json()).error.code).toBe('request_not_stopped');
  });

  it("takes no stop's place while the project is archived, nor Try again", async () => {
    const machine = await submitted({ settings: { maxFailedAttempts: 1 } });
    const { runId } = await planning(machine);
    await h.report(machine.daemon, state(runId, { state: 'ended', reason: 'max_duration' }));
    expect((await request()).stopped).toMatchObject({ cause: 'failed_attempts', count: 1 });
    await h.t.db.update(schema.projects).set({ status: 'archived' });
    expect(await stoppedItems()).toEqual([]);
    const refused = await h.call('POST', '/api/requests/1/try-again');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.code).toBe('project_archived');
    expect((await h.call('POST', '/api/requests/9/try-again')).statusCode).toBe(404);
  });

  it("does not count its machine's failure, and leaves that machine out until it connects again", async () => {
    const machine = await submitted();
    const { runId } = await planning(machine);
    await h.report(machine.daemon, state(runId, { state: 'ended', reason: 'launch_failed' }));
    expect(await request()).toMatchObject({ status: 'open', attemptCount: 0, stopped: null });
    expect((await lastComment())?.body).toMatch(
      /^The planning run on machine Laptop ended: .+\. It does not count as a failed attempt\.$/,
    );
    const machines = () =>
      h.t.db
        .select({ id: schema.machines.id, connectedAt: schema.machines.connectedAt })
        .from(schema.machines);
    const failures = requestMachineFailures(await requestRow());
    expect(failures).toMatchObject([
      { machineId: machine.id, failures: [{ cause: 'machine_problem', runId }], asked: null },
    ]);
    expect(leftOutMachines(failures, await machines()).has(machine.id)).toBe(true);
    // Connected again: no longer left out; the next end that is not the machine's clears them.
    const daemon = await h.connect(machine.token);
    expect(leftOutMachines(failures, await machines()).has(machine.id)).toBe(false);
    const next = await planning({ ...machine, daemon });
    await h.report(daemon, state(next.runId, { state: 'ended', reason: 'crashed' }));
    expect(requestMachineFailures(await requestRow())).toEqual([]);
  });
});

describe('ticket_give_up in a planning run (owner answer 5)', () => {
  it("keeps the reason as the agent's note, and the run's failure counts", async () => {
    const machine = await submitted();
    const { runId, runToken } = await planning(machine);
    const output = await h.ok(machine.daemon, runToken, 'ticket_give_up', {
      reason: 'The request asks for an Android app.',
      tried: 'Reading the request.',
    });
    expect(output).toEqual({
      request: {
        number: 1,
        text: 'A contact form on the home page.',
        status: 'planning',
        project: 'WEB',
      },
    });
    expect(await lastComment()).toMatchObject({
      author: 'agent',
      kind: 'note',
      agent: { profile: { key: 'pm' }, runId },
      body: 'I cannot plan this request.\n\nWhy:\n\nThe request asks for an Android app.\n\nWhat I tried:\n\nReading the request.',
    });
    const refused = await h.tool(machine.daemon, runToken, 'ticket_give_up', {
      reason: 'Again',
      tried: 'Nothing',
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    await h.report(machine.daemon, state(runId, { state: 'ended', reason: 'gave_up' }));
    const [run] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run).toMatchObject({
      status: 'failed',
      failureReason: 'agent_gave_up',
      decision: 'gave_up',
      outcome: 'The request asks for an Android app.',
    });
    expect(await request()).toMatchObject({ status: 'open', attemptCount: 1 });
  });
});

describe('a planning run on screen and its Stop run (owner answers 2 and 3)', () => {
  it('is listed with its request and no ticket, and Stop run stops the request', async () => {
    const machine = await submitted();
    const { runId } = await planning(machine);
    const live = await h.call('GET', `/api/runs/live?machine=${machine.id}`);
    expect(live.statusCode, live.body).toBe(200);
    expect(LiveRunsResponse.parse(live.json()).runs).toMatchObject([
      {
        id: runId,
        purpose: 'plan',
        projectKey: 'WEB',
        ticket: null,
        request: { number: 1, line: 'A contact form on the home page.' },
        branch: null,
        profile: { key: 'pm' },
      },
    ]);
    expect((await request()).run).toEqual({ id: runId, status: 'running' });

    const stopped = await h.call('POST', `/api/runs/${runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(Run.parse(stopped.json())).toMatchObject({
      status: 'cancelled',
      request: { number: 1 },
    });
    await machine.daemon.find(
      (message) => message.type === 'run.stop' && message.payload.runId === runId,
      'run.stop',
    );
    const detail = await request();
    expect(detail).toMatchObject({
      status: 'open',
      attemptCount: 0,
      run: null,
      stopped: { cause: 'stop_run', runId },
    });
    expect(detail.comments.at(-1)?.body).toBe(
      'Planning run stopped by the owner. It does not count as a failed attempt. The request is stopped. Use Try again to let the Project Manager plan it again.',
    );
    expect((await h.events('request.stopped')).at(-1)?.payload).toEqual({
      request: 1,
      project: 'WEB',
      cause: 'stop_run',
      runId,
    });
    expect(await stoppedItems()).toMatchObject([{ stop: { cause: 'stop_run', runId } }]);
    const detailRun = await h.call('GET', `/api/runs/${runId}`);
    expect(detailRun.statusCode, detailRun.body).toBe(200);

    const tried = await h.call('POST', '/api/requests/1/try-again');
    expect(tried.statusCode, tried.body).toBe(200);
    expect((await request()).comments.at(-1)?.body).toBe(
      'The owner used Try again: the request was stopped after the owner stopped its planning run. Its failed attempts count from 0 again.',
    );
  });

  it("lists a new project's planning run with no project", async () => {
    await h.start();
    const created = await h.call('POST', '/api/requests', { body: 'A shop', project: null });
    expect(created.statusCode, created.body).toBe(201);
    const machine = await h.machine();
    const { runId } = await planning(machine);
    const view = Run.parse((await h.call('GET', `/api/runs/${runId}`)).json());
    expect(view).toMatchObject({ projectKey: null, ticket: null, request: { number: 1 } });
  });
});

describe('a question left by a planning run that ended (owner answer 8)', () => {
  it('waits for no one and blocks neither request_ask nor plan_propose of the next run', async () => {
    const machine = await submitted();
    const first = await planning(machine);
    await h.ok(machine.daemon, first.runToken, 'request_ask', { question: 'Which pages?' });
    await h.report(machine.daemon, state(first.runId, { state: 'ended', reason: 'crashed' }));
    expect(await questionItems()).toEqual([]);

    const next = await planning(machine);
    expect(await questionItems()).toEqual([]);
    await h.ok(machine.daemon, next.runToken, 'request_ask', { question: 'And the colours?' });
    expect(await questionItems()).toHaveLength(1);
    const answered = await h.call('POST', '/api/requests/1/answer', { body: 'Blue.' });
    expect(answered.statusCode, answered.body).toBe(200);
    await h.ok(machine.daemon, next.runToken, 'plan_propose', {
      summary: 'A contact form.',
      tickets: [{ key: 'contact', type: 'feature', title: 'Contact form' }],
    });
    expect((await request()).status).toBe('plan_proposed');
  });

  it('keeps a later answer as a comment, delivered to no run', async () => {
    const machine = await submitted();
    const first = await planning(machine);
    const asked = await h.ok(machine.daemon, first.runToken, 'request_ask', {
      question: 'Which pages?',
    });
    await h.report(machine.daemon, state(first.runId, { state: 'ended', reason: 'crashed' }));
    const sent = machine.daemon.received.length;
    const answered = await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    expect(answered.statusCode, answered.body).toBe(200);
    const question = (asked.comment as { id: string }).id;
    expect(RequestDetail.parse(answered.json()).comments.at(-1)).toMatchObject({
      author: 'owner',
      kind: 'answer',
      body: 'The home page.',
      answers: question,
    });
    expect(
      machine.daemon.received
        .slice(sent)
        .filter((message) => message.type === 'run.input' || message.type === 'run.resume'),
    ).toEqual([]);
    // Answered once: no second answer.
    const again = await h.call('POST', '/api/requests/1/answer', { body: 'Again' });
    expect(again.statusCode).toBe(409);
    expect(ApiError.parse(again.json()).error.code).toBe('no_open_question');
  });
});
