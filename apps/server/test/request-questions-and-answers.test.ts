import { schema } from '@orchestrator/db';
import {
  ApiError,
  MCP_OUTPUT_MAX_CHARACTERS,
  RequestDetail,
  type McpError,
  type McpResult,
  type RunInput,
  type RunResume,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { startPlanningRun } from './planning-run.js';
import { RunHarness, SESSION, eventually, state } from './run-harness.js';

// Questions on a request (lot 5 step D2a; 06 section 4.4; 01 section 3.2; 04 section 6): a
// planning run reads its request with request_get and asks with request_ask; the owner's answer
// reaches it live or by resume, and a planning run that ends puts its request back to `open`.
// The planning run is the test helper's, played by a scripted daemon (owner's answer 12).

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

function refusal(result: McpResult['payload']): McpError {
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.output)}`);
  return result.error;
}

const answerInput = (daemon: ScriptedDaemon) =>
  daemon.find<RunInput>((message) => message.type === 'run.input', 'run.input');
const answerResume = (daemon: ScriptedDaemon) =>
  daemon.find<RunResume>((message) => message.type === 'run.resume', 'run.resume');

/** Request 1 on WEB, with the owner's notes, and its planning run `running` on Laptop. */
async function planning(
  options: Parameters<RunHarness['start']>[0] & { body?: string; notes?: string[] } = {},
) {
  const { body = 'A contact form on the home page.', notes = [], ...start } = options;
  await h.start(start);
  const created = await h.call('POST', '/api/requests', { body, project: 'WEB' });
  expect(created.statusCode, created.body).toBe(201);
  for (const note of notes) {
    const added = await h.call('POST', '/api/requests/1/comments', { body: note });
    expect(added.statusCode, added.body).toBe(201);
  }
  const machine = await h.machine();
  const run = await startPlanningRun(h.t.db, { request: 1, machineId: machine.id });
  await h.report(machine.daemon, state(run.runId, { state: 'working' }));
  return { ...machine, ...run };
}

/** The planning run asked its question; the daemon reported the session waiting. */
async function asked(
  options: Parameters<typeof planning>[0] = {},
  sessionAlive = true,
  question = 'Which pages should the form be on?',
) {
  const run = await planning(options);
  await h.ok(run.daemon, run.runToken, 'request_ask', { question });
  await h.report(run.daemon, state(run.runId, { state: 'waiting_human' }, sessionAlive));
  return run;
}

async function request(): Promise<RequestDetail> {
  const response = await h.call('GET', '/api/requests/1');
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

async function runRow(runId: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!row) throw new Error('no run');
  return row;
}

const words = (count: number, word = 'word') =>
  Array.from({ length: count / (word.length + 1) }, () => word).join(' ');

describe('request_get (owner answer 13 of step D)', () => {
  it('gives the request on the first page, then the comments a page at a time', async () => {
    const notes = [words(15_000, 'one'), words(15_000, 'two'), words(15_000, 'three')];
    const { daemon, runToken } = await planning({ notes });
    const first = await h.ok(daemon, runToken, 'request_get');
    expect(first.request).toEqual({
      number: 1,
      text: 'A contact form on the home page.',
      status: 'planning',
      project: 'WEB',
    });
    expect((first.comments as { body: string }[]).map((c) => c.body)).toEqual(notes.slice(0, 2));
    expect(first.next_cursor).toBe('after-2');
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    const second = await h.ok(daemon, runToken, 'request_get', { cursor: 'after-2' });
    expect(second.request).toBeNull();
    expect((second.comments as { body: string }[]).map((c) => c.body)).toEqual([notes[2]]);
    expect(second.next_cursor).toBeNull();
    const unknown = refusal(await h.tool(daemon, runToken, 'request_get', { cursor: 'page-2' }));
    expect(unknown.code).toBe('VALIDATION_FAILED');
  });

  it('gives the request alone on the first page when a comment does not fit beside it', async () => {
    const body = words(20_000, 'text');
    const note = words(20_000, 'note');
    const { daemon, runToken } = await planning({ body, notes: [note] });
    const first = await h.ok(daemon, runToken, 'request_get');
    expect((first.request as { text: string }).text).toBe(body);
    expect(first.comments).toEqual([]);
    expect(first.next_cursor).toBe('after-0');
    const second = await h.ok(daemon, runToken, 'request_get', { cursor: 'after-0' });
    expect((second.comments as { body: string }[]).map((c) => c.body)).toEqual([note]);
  });

  it('cuts a text above the output budget, raised settings only, with a marker', async () => {
    const body = words(60_000, 'text');
    const note = words(60_000, 'note');
    const { daemon, runToken } = await planning({
      settings: { ticketDescriptionMaxLength: 100_000, commentMaxLength: 100_000 },
      body,
      notes: [note],
    });
    const first = await h.ok(daemon, runToken, 'request_get');
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    const text = (first.request as { text: string }).text;
    expect(text).toMatch(/more characters are not shown/);
    expect(text).toContain('The rest of the request cannot be read through the tools');
    const second = await h.ok(daemon, runToken, 'request_get', { cursor: 'after-0' });
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    expect((second.comments as { body: string }[])[0]?.body).toContain(
      'The rest of this comment cannot be read through the tools; ask the owner with request_ask',
    );
  });
});

describe('the other tools in a planning run (owner answer 4)', () => {
  it('reads the project, refuses a ticket of its own, and keeps the progress line', async () => {
    const { daemon, runToken, runId } = await planning();
    await h.createTicket();
    expect((await h.ok(daemon, runToken, 'project_get')).key).toBe('WEB');
    expect(await h.ok(daemon, runToken, 'ticket_list')).toMatchObject({
      tickets: [{ number: 'WEB-1' }],
    });
    expect(await h.ok(daemon, runToken, 'ticket_get', { ticket: 'WEB-1' })).toMatchObject({
      ticket: { number: 'WEB-1' },
    });
    const unnamed = refusal(await h.tool(daemon, runToken, 'ticket_get'));
    expect(unnamed).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'ticket' }] });
    expect(unnamed.message).toBe(
      'Your run plans request 1 and has no ticket of its own: name a ticket with `ticket`, or read the request with request_get.',
    );
    expect(refusal(await h.tool(daemon, runToken, 'ticket_comments')).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(refusal(await h.tool(daemon, runToken, 'ci_status')).message).toBe(
      'Your run plans request 1: it has no ticket and no pull request, so ci_status has nothing to report.',
    );
    for (const [tool, input] of [
      ['ticket_comment', { body: 'A note' }],
      ['ticket_ask', { question: 'Why?' }],
      ['ticket_give_up', { reason: 'No', tried: 'Nothing' }],
    ] as const) {
      const refused = refusal(await h.tool(daemon, runToken, tool, input));
      expect(refused.code).toBe('INVALID_TRANSITION');
      expect(refused.message).toBe(
        `Your run plans request 1 and has no ticket: ${tool} is not possible in it. Read the request with request_get, and ask the owner with request_ask.`,
      );
    }
    // A tool of another role: refused by role first.
    expect(refusal(await h.tool(daemon, runToken, 'ticket_submit', {})).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(refusal(await h.tool(daemon, runToken, 'review_approve', { summary: 'Fine' }))).toEqual({
      code: 'FORBIDDEN',
      message: 'Your role (planner) does not allow review_approve.',
    });
    await h.ok(daemon, runToken, 'ticket_progress', { text: 'Reading the request' });
    expect(await runRow(runId)).toMatchObject({ progress: 'Reading the request' });
  });

  it('is refused to a ticket run, by role or by purpose', async () => {
    await h.start();
    await h.createTicket();
    const machine = await h.machine();
    const { runToken } = await h.running(machine.daemon);
    for (const [tool, input] of [
      ['request_get', {}],
      ['request_ask', { question: 'Which?' }],
    ] as const) {
      expect(refusal(await h.tool(machine.daemon, runToken, tool, input))).toEqual({
        code: 'FORBIDDEN',
        message: `${tool} is only for a planning run, which plans a request; the purpose of this run is implement.`,
      });
    }
  });
});

describe('request_ask (owner answer 5)', () => {
  it('adds the question to the request, and refuses a second one while it waits', async () => {
    const { daemon, runToken, runId } = await planning();
    const output = await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    expect(output).toMatchObject({
      comment: { author: { agent: 'test_planner' }, kind: 'question', body: 'Which pages?' },
      request: { number: 1, status: 'planning', project: 'WEB' },
    });
    const detail = await request();
    expect(detail.status).toBe('planning');
    expect(detail.comments.at(-1)).toMatchObject({
      author: 'agent',
      kind: 'question',
      body: 'Which pages?',
      agent: { runId },
    });
    const events = await h.events('request.commented');
    expect(events.at(-1)).toMatchObject({
      actor: 'agent',
      entityType: 'request',
      payload: { request: 1, project: 'WEB', kind: 'question', agent: 'test_planner', runId },
    });
    const again = refusal(await h.tool(daemon, runToken, 'request_ask', { question: 'And?' }));
    expect(again).toEqual({
      code: 'INVALID_TRANSITION',
      message:
        'You asked the owner a question and request 1 waits for the answer: request_ask is not possible now. End your turn; the answer arrives as your next message.',
    });
  });

  it('refuses a question above Longest comment, and on a request that is not planning', async () => {
    const { daemon, runToken } = await planning({ settings: { commentMaxLength: 100 } });
    const long = refusal(
      await h.tool(daemon, runToken, 'request_ask', { question: 'x'.repeat(101) }),
    );
    expect(long).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'question' }] });
    await h.t.db.update(schema.requests).set({ status: 'open' });
    expect(
      refusal(await h.tool(daemon, runToken, 'request_ask', { question: 'Which pages?' })),
    ).toEqual({
      code: 'INVALID_TRANSITION',
      message: 'Request 1 is open: request_ask needs it planning. End your turn.',
    });
  });
});

describe("the owner's answer (owner answers 6, 9 and 10)", () => {
  it('reaches a session still open live, in the words of request-answer.md', async () => {
    const { daemon, runId } = await asked();
    const response = await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    expect(response.statusCode, response.body).toBe(200);
    const detail = RequestDetail.parse(response.json());
    const [question, answer] = detail.comments.slice(-2);
    expect(answer).toMatchObject({ author: 'owner', kind: 'answer', body: 'The home page.' });
    expect(answer?.answers).toBe(question?.id);
    expect(detail.status).toBe('planning');
    const input = await answerInput(daemon);
    expect(input.payload.runId).toBe(runId);
    expect(input.payload.text).toContain('The owner answered your question about the request.');
    expect(input.payload.text).toContain('Which pages should the form be on?');
    expect(input.payload.text).toContain('The home page.');
    expect(input.payload.text).toContain('ask again with `request_ask`');
    daemon.send({ type: 'ack', id: input.id, payload: { ok: true } });
    await eventually('the input confirmed', async () => {
      expect((await runRow(runId)).answerInputId).toBeNull();
    });
    expect((await h.events('request.commented')).at(-1)).toMatchObject({
      actor: 'owner',
      payload: { request: 1, kind: 'answer' },
    });
    const again = await h.call('POST', '/api/requests/1/answer', { body: 'More' });
    expect(again.statusCode).toBe(409);
    expect(ApiError.parse(again.json()).error.code).toBe('no_open_question');
  });

  it('resumes the session when it closed just before the live answer', async () => {
    const { daemon, runId } = await asked();
    await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    const input = await answerInput(daemon);
    daemon.send({ type: 'ack', id: input.id, payload: { ok: false, message: 'session closed' } });
    const resume = await answerResume(daemon);
    expect(resume.payload).toMatchObject({ runId, claudeSessionId: SESSION });
    expect(resume.payload.message).toContain('The home page.');
  });

  it('after the waiting run lifetime, resumes the run, its cuts pointing to request_get', async () => {
    const lines = (word: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${word} ${String(i)} ${'x'.repeat(300)}`).join('\n');
    const { daemon, runId } = await asked(
      { settings: { commentMaxLength: 100_000 } },
      false,
      lines('Question line', 300),
    );
    const answered = await h.call('POST', '/api/requests/1/answer', {
      body: lines('Answer line', 300),
    });
    expect(answered.statusCode, answered.body).toBe(200);
    const resume = await answerResume(daemon);
    expect(resume.payload.runId).toBe(runId);
    expect(resume.payload.message).toContain('Read it in full with `request_get`');
    expect(resume.payload.message).not.toContain('ticket_comments');
    expect((await runRow(runId)).status).toBe('dispatched');
    daemon.send({ type: 'ack', id: resume.id, payload: { ok: true } });
    await h.report(daemon, state(runId, { state: 'working' }));
    expect((await request()).status).toBe('planning');
  });

  it('keeps the answer for a run paused on a usage limit (owner answer 8)', async () => {
    const { daemon, runId } = await asked();
    await h.report(daemon, state(runId, { state: 'quota_paused' }, false));
    const response = await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    expect(response.statusCode, response.body).toBe(200);
    expect((await request()).comments.at(-1)).toMatchObject({ kind: 'answer' });
    expect(await runRow(runId)).toMatchObject({ status: 'paused_quota', answerInputId: null });
  });

  it('fails the run machine_offline when its machine is offline, and opens the request again', async () => {
    const { daemon, runId } = await asked({}, false);
    await daemon.close();
    await eventually('the machine offline', async () => {
      const [machine] = await h.t.db.select().from(schema.machines);
      expect(machine?.status).toBe('offline');
    });
    const response = await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    expect(response.statusCode, response.body).toBe(200);
    const detail = RequestDetail.parse(response.json());
    expect(detail.status).toBe('open');
    expect(detail.comments.map((comment) => comment.kind)).toEqual([
      'question',
      'answer',
      'status_change',
    ]);
    expect(detail.comments.at(-1)).toMatchObject({
      author: 'system',
      body: 'Your answer could not reach the planning run: machine Laptop is offline. The run failed as "machine offline" and does not count as a failed attempt. The request is open again, and your answer stays here.',
    });
    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
    });
    expect((await h.events('request.status_changed')).map((event) => event.payload)).toEqual([
      { request: 1, project: 'WEB', from: 'open', to: 'planning', cause: 'run_started', runId },
      {
        request: 1,
        project: 'WEB',
        from: 'planning',
        to: 'open',
        cause: 'run_ended',
        runId,
        failureReason: 'machine_offline',
      },
    ]);
  });

  it('fails the run machine_offline when the machine does not confirm the resume in time', async () => {
    const { daemon, runId } = await asked(
      { daemonSecondMs: 50, settings: { dispatchAckTimeoutSeconds: 5 } },
      false,
    );
    await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    await answerResume(daemon);
    await eventually('the run failed', async () => {
      expect(await runRow(runId)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
    });
    const detail = await request();
    expect(detail.status).toBe('open');
    expect(detail.comments.at(-1)?.body).toMatch(
      /^Your answer could not reach the planning run: machine Laptop did not confirm it in time\./,
    );
    await daemon.find((message) => message.type === 'run.stop', 'run.stop');
  }, 15_000);

  it('fails the run machine_offline when the machine refuses the resume', async () => {
    const { daemon, runId } = await asked({}, false);
    await h.call('POST', '/api/requests/1/answer', { body: 'The home page.' });
    const resume = await answerResume(daemon);
    daemon.send({ type: 'ack', id: resume.id, payload: { ok: false, message: 'no such session' } });
    await eventually('the run failed', async () => {
      expect(await runRow(runId)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
    });
    expect((await request()).comments.at(-1)?.body).toMatch(
      /^Your answer could not reach the planning run: machine Laptop refused it \(no such session\)\./,
    );
  });

  it('refuses an answer with no question waiting, too long, to an unknown request or an archived project', async () => {
    const { daemon, runToken } = await planning({ settings: { commentMaxLength: 100 } });
    const none = await h.call('POST', '/api/requests/1/answer', { body: 'Yes' });
    expect(none.statusCode).toBe(409);
    expect(ApiError.parse(none.json()).error.message).toBe(
      'The request has no question waiting for an answer: it is planning',
    );
    await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    const long = await h.call('POST', '/api/requests/1/answer', { body: 'x'.repeat(101) });
    expect(long.statusCode).toBe(400);
    expect(ApiError.parse(long.json()).error.code).toBe('invalid_request');
    expect((await h.call('POST', '/api/requests/9/answer', { body: 'Yes' })).statusCode).toBe(404);
    expect((await h.call('POST', '/api/requests/x/answer', { body: 'Yes' })).statusCode).toBe(404);
    await h.t.db.update(schema.projects).set({ status: 'archived' });
    const archived = await h.call('POST', '/api/requests/1/answer', { body: 'Yes' });
    expect(archived.statusCode).toBe(409);
    expect(ApiError.parse(archived.json()).error.code).toBe('project_archived');
  });
});

describe('the end of a planning run (owner answer 7)', () => {
  it('opens its request again, not counted, whatever ended it', async () => {
    const { daemon, runId } = await planning();
    await h.report(daemon, { ...state(runId, { state: 'ended', reason: 'crashed' }) });
    expect(await runRow(runId)).toMatchObject({ status: 'failed', failureReason: 'crash' });
    const detail = await request();
    expect(detail).toMatchObject({ status: 'open' });
    const [row] = await h.t.db.select().from(schema.requests);
    expect(row?.attemptCount).toBe(0);
    expect((await h.events('request.status_changed')).at(-1)?.payload).toEqual({
      request: 1,
      project: 'WEB',
      from: 'planning',
      to: 'open',
      cause: 'run_ended',
      runId,
      failureReason: 'crash',
    });
  });
});
