import { schema } from '@orchestrator/db';
import {
  ApiError,
  FIRST_MESSAGE_MAX_BYTES,
  MCP_OUTPUT_MAX_CHARACTERS,
  MCP_TOOLS,
  SETTINGS,
  TicketDetail,
  type McpError,
  type McpResult,
  type RunInput,
  type RunResume,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// The MCP backend and questions (lot 2 step K; 06; 04, sections 2, 3.1 and 6).

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

function refusal(result: McpResult['payload']): McpError {
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.output)}`);
  return result.error;
}

/** A ready project, `WEB-1` assigned to the Web Developer, and its run `running` on `Laptop`. */
async function working(options: Parameters<RunHarness['start']>[0] = {}) {
  await h.start(options);
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  return { ...machine, ...run };
}

const REPORT = {
  criteria: [
    { number: 1, status: 'met', justification: 'ContactForm renders the form' },
    { number: 2, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

describe('the run token (06, section 2)', () => {
  it('is refused once the run ended, and from another machine', async () => {
    const { daemon, runId, runToken } = await working();
    const other = await h.machine('Desk');
    expect(refusal(await h.tool(other.daemon, runToken, 'ticket_get')).code).toBe('FORBIDDEN');
    // The daemon relays whatever the agent sends: the same token keeps working on its machine.
    expect((await h.tool(daemon, runToken, 'ticket_get')).ok).toBe(true);

    await h.report(daemon, state(runId, { state: 'ended', reason: 'crashed' }));
    const expired = refusal(await h.tool(daemon, runToken, 'ticket_comment', { body: 'Hello' }));
    expect(expired.code).toBe('FORBIDDEN');
    expect(expired.message).toMatch(/run has ended/);
    expect(refusal(await h.tool(daemon, 'ort_unknown', 'ticket_get')).code).toBe('FORBIDDEN');
  });

  it('refuses an invalid input with the fields at fault', async () => {
    const { daemon, runToken } = await working();
    const error = refusal(
      await h.tool(daemon, runToken, 'ticket_comment', { body: 'Hi', extra: true }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.[0]?.field).toBe('input');
    const missing = refusal(await h.tool(daemon, runToken, 'ticket_ask', {}));
    expect(missing).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'question' }] });
  });
});

describe('role permissions (06, section 5)', () => {
  it('refuses a tool the role does not have, naming the role', async () => {
    await h.start();
    await h.createTicket();
    // The API refuses a reviewer as assignee (03, section 4): set as a damaged row would be.
    const [quality] = await h.t.db
      .select({ id: schema.agentProfiles.id })
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, 'quality'));
    await h.t.db.update(schema.tickets).set({ assigneeProfileId: quality?.id ?? null });
    const { daemon } = await h.machine();
    const { runToken } = await h.running(daemon);
    const error = refusal(await h.tool(daemon, runToken, 'ticket_submit', REPORT));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toMatch(/reviewer/);
    // Every other lot 2 tool is allowed to every role.
    expect((await h.tool(daemon, runToken, 'ticket_comment', { body: 'Looking' })).ok).toBe(true);
    // The review tools are the reviewer's, but only in a review run (06, section 4.5), which the
    // server starts from lot 3 step H: this run implements the ticket.
    const approve = refusal(await h.tool(daemon, runToken, 'review_approve', { summary: 'Good.' }));
    expect(approve).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(approve.message).toBe(
      'review_approve is only for a review run of a ticket in in_review; the purpose of this run is implement.',
    );
  });

  it("refuses the review tools to a builder, naming its role (lot 3's protocol)", async () => {
    const { daemon, runToken } = await working();
    for (const [tool, input] of [
      ['review_approve', { summary: 'Good.' }],
      ['review_request_changes', { points: [{ body: 'Test it.' }] }],
    ] as const) {
      const error = refusal(await h.tool(daemon, runToken, tool, input));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toMatch(/builder/);
    }
  });
});

describe('ci_status (06, section 4.1)', () => {
  it('says no work was accepted yet, so there is no commit, pull request or result', async () => {
    const { daemon, runToken } = await working();
    const result = await h.tool(daemon, runToken, 'ci_status');
    expect(result).toEqual({
      ok: true,
      output: {
        commit: null,
        pull_request: null,
        read_at: null,
        note: 'No work of this ticket has been accepted yet, so there is no CI result to read. CI is read after ticket_submit accepts your work.',
        ci: null,
      },
    });
  });
});

describe('reading tools (06, section 4.1)', () => {
  it('reads the project, tickets, comments and profiles, and writes no event', async () => {
    const { daemon, runToken } = await working();
    await h.createTicket({ title: 'Opening hours', type: 'docs', assignee: null });
    const before = (await h.t.db.select().from(schema.events)).length;

    expect(await h.ok(daemon, runToken, 'project_get')).toEqual({
      key: 'WEB',
      name: 'Bakery website',
      description: 'A website for the bakery.',
      kind: 'website',
      repository: { owner: 'octo-owner', name: 'bakery', default_branch: 'main' },
      conventions: {
        claude_md: 'CLAUDE.md',
        user_docs: 'docs/user/',
        dev_docs: 'docs/dev/',
        adrs: 'docs/adr/',
      },
      missing: [],
    });
    const own = await h.ok(daemon, runToken, 'ticket_get');
    expect(own).toMatchObject({
      ticket: {
        number: 'WEB-1',
        status: 'in_progress',
        assignee: 'web_dev',
        acceptance_criteria: ['The contact page has a form', 'The e-mail address is checked'],
        created_by: 'owner',
        dod_report: null,
        pull_request_url: null,
      },
    });
    expect(await h.ok(daemon, runToken, 'ticket_get', { ticket: 'WEB-2' })).toMatchObject({
      ticket: { number: 'WEB-2', title: 'Opening hours', assignee: null },
    });
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_get', { ticket: 'WEB-9' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(refusal(await h.tool(daemon, runToken, 'ticket_get', { ticket: 'SHOP-1' })).code).toBe(
      'NOT_FOUND',
    );

    expect(await h.ok(daemon, runToken, 'ticket_list', { type: ['docs'] })).toEqual({
      tickets: [
        {
          number: 'WEB-2',
          type: 'docs',
          title: 'Opening hours',
          status: 'todo',
          priority: 'normal',
          assignee: null,
          blocked: false,
        },
      ],
      next_cursor: null,
    });
    expect(
      await h.ok(daemon, runToken, 'ticket_list', { text: 'VISITORS', assignee: 'web_dev' }),
    ).toMatchObject({ tickets: [{ number: 'WEB-1' }] });
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_list', { assignee: 'nobody' })).code,
    ).toBe('NOT_FOUND');
    expect(refusal(await h.tool(daemon, runToken, 'ticket_list', { cursor: 'page-2' })).code).toBe(
      'VALIDATION_FAILED',
    );

    const agents = await h.ok(daemon, runToken, 'agent_list');
    expect(agents).toMatchObject({
      agents: [
        { key: 'architect', role: 'builder' },
        { key: 'pm', role: 'planner' },
        { key: 'quality', role: 'reviewer' },
        { key: 'web_dev', role: 'builder' },
      ],
    });
    expect(await h.ok(daemon, runToken, 'ticket_comments')).toEqual({
      comments: [],
      next_cursor: null,
    });
    expect((await h.t.db.select().from(schema.events)).length).toBe(before);
  });

  it('pages tickets and comments under the output limit, and cuts a text too long for it', async () => {
    const { daemon, runToken } = await working({ settings: { commentMaxLength: 100_000 } });
    const ticketOne = await h.ticket(1);
    const [project] = await h.t.db.select().from(schema.projects);
    if (!project) throw new Error('no project');
    // 60 more tickets: pages of at most 50.
    await h.t.db.insert(schema.tickets).values(
      Array.from({ length: 60 }, (_, index) => ({
        projectId: project.id,
        number: index + 2,
        type: 'chore',
        title: `Chore ${String(index + 2)}`,
        description: '',
        priority: 'low',
        status: 'todo',
        createdBy: 'owner',
      })),
    );
    await h.t.db.update(schema.projects).set({ lastTicketNumber: 61 });
    const first = await h.ok(daemon, runToken, 'ticket_list');
    expect((first.tickets as unknown[]).length).toBe(50);
    expect(first.next_cursor).toBe('after-50');
    const second = await h.ok(daemon, runToken, 'ticket_list', { cursor: first.next_cursor });
    expect((second.tickets as { number: string }[]).map((each) => each.number)).toEqual(
      Array.from({ length: 11 }, (_, index) => `WEB-${String(index + 51)}`),
    );
    expect(second.next_cursor).toBeNull();

    // Five comments of 15,000 characters: two per page of 40,000.
    const long = (label: string, length: number) =>
      Array.from({ length: Math.ceil(length / 100) }, (_, index) =>
        `${label} line ${String(index).padStart(5, '0')} `.padEnd(99, '.'),
      )
        .join('\n')
        .slice(0, length);
    const at = Date.now();
    await h.t.db.insert(schema.comments).values(
      Array.from({ length: 5 }, (_, index) => ({
        ticketId: ticketOne.id,
        author: 'owner',
        kind: 'note',
        body: long(`Note ${String(index)}`, 15_000),
        createdAt: new Date(at + index),
      })),
    );
    const seen: string[] = [];
    let cursor: unknown;
    let pages = 0;
    do {
      const page = await h.ok(daemon, runToken, 'ticket_comments', cursor ? { cursor } : {});
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
      seen.push(...(page.comments as { body: string }[]).map((each) => each.body.slice(0, 6)));
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(['Note 0', 'Note 1', 'Note 2', 'Note 3', 'Note 4']);

    // One comment above the budget is cut at a line boundary, with its marker.
    await h.t.db.delete(schema.comments);
    const huge = long('Huge', 90_000);
    await h.t.db
      .insert(schema.comments)
      .values({ ticketId: ticketOne.id, author: 'owner', kind: 'note', body: huge });
    const cut = await h.ok(daemon, runToken, 'ticket_comments');
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    const body = (cut.comments as { body: string }[])[0]?.body ?? '';
    const [kept, marker] = body.split('\n\n[Cut here: ');
    expect(huge.startsWith(`${kept ?? ''}\n`)).toBe(true);
    expect(marker).toMatch(
      new RegExp(`^${String(huge.length - (kept ?? '').length)} more characters`),
    );

    // A description above the budget, the same way.
    await h.t.db
      .update(schema.tickets)
      .set({ description: long('Description', 60_000) })
      .where(eq(schema.tickets.id, ticketOne.id));
    const ticket = await h.ok(daemon, runToken, 'ticket_get');
    expect(JSON.stringify(ticket).length).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    expect((ticket.ticket as { description: string }).description).toMatch(
      /\n\n\[Cut here: \d+ more characters/,
    );
  });
});

describe('ticket_progress (06, section 4.2)', () => {
  it('is never refused: the latest line is shown at most once per interval, with its event', async () => {
    // One second of the settings lasts 50 ms: the interval of 60 seconds is 3 seconds.
    const { daemon, runId, runToken } = await working({ daemonSecondMs: 50 });
    expect(
      await h.ok(daemon, runToken, 'ticket_progress', { text: 'Reading CLAUDE.md' }),
    ).toMatchObject({ progress: 'Reading CLAUDE.md' });
    expect((await h.run(runId)).progress?.text).toBe('Reading CLAUDE.md');
    await h.ok(daemon, runToken, 'ticket_progress', { text: 'Writing the form' });
    await h.ok(daemon, runToken, 'ticket_progress', { text: 'Writing the tests' });
    // Within the interval, the first line is still the one shown.
    expect((await h.run(runId)).progress?.text).toBe('Reading CLAUDE.md');
    await eventually(
      'the latest line shown',
      async () => {
        expect((await h.run(runId)).progress?.text).toBe('Writing the tests');
      },
      10_000,
    );
    const events = await h.events('run.progress');
    expect(events.map((event) => [event.actor, (event.payload as { text: string }).text])).toEqual([
      ['agent', 'Reading CLAUDE.md'],
      ['agent', 'Writing the tests'],
    ]);
  }, 20_000);
});

describe('ticket_comment and ticket_ask', () => {
  it('adds the agent note, and refuses a text above the setting, stating its value', async () => {
    const { daemon, runId, runToken } = await working({ settings: { commentMaxLength: 30 } });
    const output = await h.ok(daemon, runToken, 'ticket_comment', { body: 'The form is ready.' });
    expect(output).toMatchObject({
      comment: { author: { agent: 'web_dev' }, kind: 'note', body: 'The form is ready.' },
    });
    const [comment] = (await h.ticket()).timeline.filter((entry) => entry.type === 'comment');
    expect(comment).toMatchObject({
      comment: { author: 'agent', agent: { profile: { key: 'web_dev' }, runId } },
    });
    const [event] = await h.events('ticket.commented');
    expect(event).toMatchObject({ actor: 'agent', payload: { agent: 'web_dev', runId } });

    const error = refusal(
      await h.tool(daemon, runToken, 'ticket_comment', { body: 'x'.repeat(31) }),
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ setting: 'commentMaxLength' }],
    });
    expect(error.message).toMatch(/at most 30 characters.*Longest comment.*30/);
  });

  it('asks the owner: the ticket waits; a second question is refused', async () => {
    const { daemon, runToken } = await working();
    const output = await h.ok(daemon, runToken, 'ticket_ask', { question: 'Which address?' });
    expect(output).toMatchObject({
      comment: { kind: 'question', body: 'Which address?' },
      ticket: { status: 'waiting_human' },
    });
    expect((await h.ticket()).status).toBe('waiting_human');
    const change = (await h.events('ticket.status_changed')).at(-1);
    expect(change).toMatchObject({ actor: 'agent', payload: { action: 'question_asked' } });
    const again = refusal(await h.tool(daemon, runToken, 'ticket_ask', { question: 'Or?' }));
    expect(again.code).toBe('INVALID_TRANSITION');
    expect(refusal(await h.tool(daemon, runToken, 'ticket_submit', REPORT)).code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('ticket_give_up', () => {
  it("records the agent's reasons as its note; the end counts as a failed attempt", async () => {
    const { daemon, runId, runToken } = await working();
    await h.ok(daemon, runToken, 'ticket_give_up', {
      reason: 'The site has no mail server.',
      tried: 'Looked for SMTP settings.',
    });
    const note = (await h.ticket()).timeline.find((entry) => entry.type === 'comment');
    expect(note).toMatchObject({ comment: { author: 'agent', kind: 'note' } });
    if (note?.type !== 'comment') throw new Error('no note');
    expect(note.comment.body).toMatch(/no mail server[\s\S]*SMTP settings/);
    expect(refusal(await h.tool(daemon, runToken, 'ticket_submit', REPORT)).message).toMatch(
      /already gave up/,
    );
    await h.report(daemon, state(runId, { state: 'ended', reason: 'gave_up' }));
    expect(await h.run(runId)).toMatchObject({ status: 'failed', failureReason: 'agent_gave_up' });
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1 });
  });
});

describe('ticket_create (06, section 4.3), then Accept and Reject (04, section 2)', () => {
  it('creates proposed tickets within the per-run limit fixed at the start', async () => {
    const { daemon, runId, runToken } = await working({ settings: { maxAgentTicketsPerRun: 2 } });
    // A change of the setting applies to later runs only (04, section 8).
    expect(
      (await h.call('PUT', '/api/settings/maxAgentTicketsPerRun', { value: 5 })).statusCode,
    ).toBe(200);
    const input = {
      type: 'bug',
      title: 'Footer link is broken',
      description: 'The footer links to /contakt.',
      acceptance_criteria: ['The footer links to the contact page'],
      priority: 'high',
      blocked_by: ['WEB-1'],
      assignee: 'architect',
    };
    const created = await h.ok(daemon, runToken, 'ticket_create', input);
    expect(created).toMatchObject({
      ticket: {
        number: 'WEB-2',
        status: 'proposed',
        assignee: 'architect',
        created_by: { agent: 'web_dev' },
        blocked_by: [{ number: 'WEB-1' }],
      },
    });
    const detail = await h.ticket(2);
    expect(detail).toMatchObject({
      createdBy: 'agent',
      createdByAgent: { profile: { key: 'web_dev' }, runId },
      blocked: true,
    });
    const event = (await h.events('ticket.created')).at(-1);
    expect(event).toMatchObject({ actor: 'agent', payload: { ticket: 'WEB-2', agent: 'web_dev' } });

    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_create', { ...input, blocked_by: ['WEB-7'] })),
    ).toMatchObject({ code: 'NOT_FOUND', details: [{ field: 'blocked_by' }] });
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_create', { ...input, assignee: 'nobody' }))
        .code,
    ).toBe('NOT_FOUND');
    // A reviewer never implements (03, section 4; lot 3 step H1).
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_create', { ...input, assignee: 'quality' })),
    ).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'assignee' }] });
    await h.ok(daemon, runToken, 'ticket_create', { ...input, blocked_by: [] });
    const limit = refusal(await h.tool(daemon, runToken, 'ticket_create', input));
    expect(limit).toMatchObject({
      code: 'LIMIT_REACHED',
      details: [{ setting: 'maxAgentTicketsPerRun' }],
    });
    expect(limit.message).toMatch(/Limit of 2 tickets per run reached.*: 2\)/);
    // The limit as Settings names it, never another wording.
    expect(limit.message).toContain(`(setting "${SETTINGS.maxAgentTicketsPerRun.label}": 2)`);
  });

  it('refuses texts above the owner form limits, and an archived project', async () => {
    const { daemon, runToken } = await working({ settings: { ticketTitleMaxLength: 12 } });
    const input = {
      type: 'bug',
      title: 'A title that is too long',
      description: '',
      acceptance_criteria: [],
      priority: 'normal',
    };
    const error = refusal(await h.tool(daemon, runToken, 'ticket_create', input));
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'title', setting: 'ticketTitleMaxLength' }],
    });
    expect(error.message).toMatch(/at most 12 characters/);
    expect(error.message).toContain(`(setting "${SETTINGS.ticketTitleMaxLength.label}": 12)`);
    // Lowered once the run's ticket exists, since it has two criteria.
    expect(
      (await h.call('PUT', '/api/settings/ticketMaxAcceptanceCriteria', { value: 1 })).statusCode,
    ).toBe(200);
    const criteria = refusal(
      await h.tool(daemon, runToken, 'ticket_create', {
        ...input,
        title: 'Short',
        acceptance_criteria: ['One', 'Two'],
      }),
    );
    expect(criteria).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'acceptance_criteria', setting: 'ticketMaxAcceptanceCriteria' }],
    });
    // The limit as Settings names it, never another wording.
    expect(criteria.message).toContain(
      `(setting "${SETTINGS.ticketMaxAcceptanceCriteria.label}": 1)`,
    );
    await h.t.db.update(schema.projects).set({ status: 'archived' });
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_create', { ...input, title: 'Short' })).code,
    ).toBe('INVALID_TRANSITION');
  });

  it('lets the owner accept or reject a proposed ticket, never one of their own', async () => {
    const { daemon, runToken } = await working();
    const input = {
      type: 'docs',
      title: 'Help page',
      description: '',
      acceptance_criteria: [],
      priority: 'low',
    };
    await h.ok(daemon, runToken, 'ticket_create', input);
    await h.ok(daemon, runToken, 'ticket_create', { ...input, title: 'Other page' });

    const accepted = await h.call('POST', '/api/projects/WEB/tickets/2/accept');
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(TicketDetail.parse(accepted.json()).status).toBe('todo');
    const rejected = await h.call('POST', '/api/projects/WEB/tickets/3/reject', {
      comment: 'Not needed.',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const detail = TicketDetail.parse(rejected.json());
    expect(detail.status).toBe('cancelled');
    expect(detail.timeline).toContainEqual(
      expect.objectContaining({
        type: 'comment',
        comment: expect.objectContaining({ kind: 'status_change', body: 'Not needed.' }) as unknown,
      }),
    );
    const actions = (await h.events('ticket.status_changed')).map(
      (event) => (event.payload as { action: string }).action,
    );
    expect(actions).toEqual(['run_now', 'accept', 'reject']);

    const owner = await h.createTicket({ title: 'Mine' });
    await h.t.db
      .update(schema.tickets)
      .set({ status: 'proposed' })
      .where(eq(schema.tickets.id, owner.id));
    const refused = await h.call(
      'POST',
      `/api/projects/WEB/tickets/${String(owner.number)}/accept`,
    );
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.message).toMatch(/only for a ticket an agent/);
    // Reject without a comment writes none.
    await h.ok(daemon, runToken, 'ticket_create', { ...input, title: 'Third' });
    const plain = await h.call('POST', '/api/projects/WEB/tickets/5/reject');
    expect(plain.statusCode, plain.body).toBe(200);
  });
});

// ticket_submit's checks: submission.test.ts (lot 3 step F2).

describe('questions and answers (04, section 6)', () => {
  const answerInput = (daemon: ScriptedDaemon) =>
    daemon.find<RunInput>((message) => message.type === 'run.input', 'run.input');
  const answerResume = (daemon: ScriptedDaemon) =>
    daemon.find<RunResume>((message) => message.type === 'run.resume', 'run.resume');

  async function asked(
    options: Parameters<RunHarness['start']>[0] = {},
    question = 'Which address?',
  ) {
    const run = await working(options);
    await h.ok(run.daemon, run.runToken, 'ticket_ask', { question });
    return run;
  }

  it('sends the answer live to a session still open', async () => {
    const { daemon, runId } = await asked();
    await h.report(daemon, state(runId, { state: 'waiting_human' }));
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/answer', {
      body: 'hello@bakery.example',
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = TicketDetail.parse(response.json());
    expect(detail.status).toBe('in_progress');
    const answer = detail.timeline.find(
      (entry) => entry.type === 'comment' && entry.comment.kind === 'answer',
    );
    const question = detail.timeline.find(
      (entry) => entry.type === 'comment' && entry.comment.kind === 'question',
    );
    if (answer?.type !== 'comment' || question?.type !== 'comment') throw new Error('no answer');
    expect(answer.comment.answers).toBe(question.comment.id);

    const input = await answerInput(daemon);
    expect(input.payload.runId).toBe(runId);
    expect(input.payload.text).toMatch(/Which address\?[\s\S]*hello@bakery\.example/);
    daemon.send({ type: 'ack', id: input.id, payload: { ok: true } });
    await eventually('the input acknowledged', async () => {
      const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      expect(row?.answerInputId).toBeNull();
    });
    // No question is open any more.
    const again = await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'More' });
    expect(again.statusCode).toBe(409);
    expect(ApiError.parse(again.json()).error.code).toBe('no_open_question');
  });

  it('resumes the session when it closed just before the live answer', async () => {
    const { daemon, runId } = await asked();
    await h.report(daemon, state(runId, { state: 'waiting_human' }));
    await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'hello@bakery.example' });
    const input = await answerInput(daemon);
    daemon.send({
      type: 'ack',
      id: input.id,
      payload: { ok: false, message: 'session closed: use run.resume' },
    });
    const resume = await answerResume(daemon);
    expect(resume.payload.message).toMatch(/hello@bakery\.example/);
    expect((await h.run(runId)).status).toBe('dispatched');
  });

  it('after the waiting run lifetime, resumes the run with the question cut before the answer', async () => {
    const lines = (label: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `${label} ${String(index).padStart(4, '0')} ${'x'.repeat(90)}`,
      ).join('\n');
    const question = lines('Question line', 600); // about 60,000 bytes
    const { daemon, runId } = await asked({ settings: { commentMaxLength: 100_000 } }, question);
    await h.report(daemon, state(runId, { state: 'waiting_human' }, false));
    const answer = lines('Answer line', 600);
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: answer });
    expect(response.statusCode, response.body).toBe(200);
    const resume = await answerResume(daemon);
    const { message } = resume.payload;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(FIRST_MESSAGE_MAX_BYTES);
    expect(message).toContain(answer);
    expect(message).toContain('[Your question is cut here');
    expect(message).not.toContain("[The owner's answer is cut here");
    // Whole lines of the question only, from its start.
    const kept = message.split('\n').filter((line) => line.startsWith('Question line'));
    expect(kept.length).toBeGreaterThan(0);
    expect(question.startsWith(kept.join('\n'))).toBe(true);
    expect(await h.run(runId)).toMatchObject({ status: 'dispatched' });

    daemon.send({ type: 'ack', id: resume.id, payload: { ok: true } });
    await h.report(
      daemon,
      state(runId, { state: 'starting', claudeCodeVersion: '2.1.283 (Claude Code)' }),
    );
    await h.report(daemon, state(runId, { state: 'working' }));
    expect((await h.run(runId)).status).toBe('running');
  });

  it('cuts the question down to its marker, then the answer, when both are very long', async () => {
    // Two bytes per "é": within the longest comment, above the byte budget.
    const lines = (label: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `${label} ${String(index).padStart(4, '0')} ${'é'.repeat(150)}`,
      ).join('\n');
    const question = lines('Question line', 300);
    const { daemon, runId } = await asked({ settings: { commentMaxLength: 100_000 } }, question);
    await h.report(daemon, state(runId, { state: 'waiting_human' }, false));
    const answer = lines('Answer line', 330); // about 105,000 bytes
    await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: answer });
    const { message } = (await answerResume(daemon)).payload;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(FIRST_MESSAGE_MAX_BYTES);
    expect(message).not.toContain('Question line');
    expect(message).toContain('[Your question is cut here');
    expect(message).toContain("[The owner's answer is cut here");
    const kept = message.split('\n').filter((line) => line.startsWith('Answer line'));
    expect(kept.length).toBeGreaterThan(250);
    expect(answer.startsWith(kept.join('\n'))).toBe(true);
  });

  it('fails the run with machine_offline when its machine is offline, and when it does not confirm', async () => {
    const offline = await asked();
    await h.report(offline.daemon, state(offline.runId, { state: 'waiting_human' }, false));
    await offline.daemon.close();
    await eventually('the machine offline', async () => {
      const [machine] = await h.t.db.select().from(schema.machines);
      expect(machine?.status).toBe('offline');
    });
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'Yes' });
    expect(response.statusCode, response.body).toBe(200);
    expect(TicketDetail.parse(response.json())).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(await h.run(offline.runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
    });
    const comments = (await h.ticket()).timeline.flatMap((entry) =>
      entry.type === 'comment' ? [entry.comment.body] : [],
    );
    expect(comments.at(-1)).toMatch(/could not reach the run: machine Laptop is offline/);
  });

  it('fails the run with machine_offline when the machine does not confirm the resume in time', async () => {
    const { daemon, runId } = await asked({
      daemonSecondMs: 50,
      settings: { dispatchAckTimeoutSeconds: 5 },
    });
    await h.report(daemon, state(runId, { state: 'waiting_human' }, false));
    await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'Yes' });
    await answerResume(daemon);
    await eventually('the run failed', async () => {
      expect(await h.run(runId)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
    });
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    // The late session is stopped.
    await daemon.find((message) => message.type === 'run.stop', 'run.stop');
  }, 15_000);

  it('delivers the answer at once even when the account is at its maximum (owner decision)', async () => {
    const { daemon, runId } = await asked();
    await h.report(daemon, state(runId, { state: 'waiting_human' }, false));
    // Another ticket runs on the account meanwhile: a waiting run does not count.
    await h.createTicket({ title: 'Opening hours' });
    await h.running(daemon, 2);
    await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'Yes' });
    await answerResume(daemon);
    expect((await h.run(runId)).status).toBe('dispatched');
  });
});

describe('tool descriptions', () => {
  it('cover every tool of lots 2 to 5', () => {
    expect(Object.keys(MCP_TOOLS).sort()).toEqual(
      [
        'agent_list',
        'ci_status',
        'request_ask',
        'request_get',
        'review_approve',
        'review_request_changes',
        'project_get',
        'ticket_ask',
        'ticket_comment',
        'ticket_comments',
        'ticket_create',
        'ticket_get',
        'ticket_give_up',
        'ticket_list',
        'ticket_progress',
        'ticket_submit',
        'ticket_update',
      ].sort(),
    );
  });
});
