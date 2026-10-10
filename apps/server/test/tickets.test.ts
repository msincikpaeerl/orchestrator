import { schema } from '@orchestrator/db';
import {
  ApiError,
  OWNER_TRANSITIONS,
  ProjectListResponse,
  TicketDetail,
  TicketListResponse,
  TicketStatus,
  type OwnerTicketAction,
  type SettingValues,
} from '@orchestrator/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let cookie: string;

async function start(settings: Partial<SettingValues> = {}) {
  t = await startTestApp({ settings });
  cookie = await createOwner(t.app);
}

beforeEach(async () => {
  await start();
  await seedProject('WEB');
});

afterEach(async () => {
  await t.close();
});

type Project = typeof schema.projects.$inferInsert;

/** A project as its setup leaves it; the projects API has its own tests. */
async function seedProject(key: string, overrides: Partial<Project> = {}) {
  const [row] = await t.db
    .insert(schema.projects)
    .values({
      key,
      name: key,
      slug: key.toLowerCase(),
      description: '',
      kind: 'web_app',
      repoOwner: 'owner',
      repoName: key.toLowerCase(),
      repoOrigin: 'created',
      repoPrivate: true,
      defaultBranch: 'main',
      setupStatus: 'ready',
      branchProtection: 'applied',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('project not inserted');
  return row;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return t.app.inject({ method, url: `/api/projects/${url}`, headers: { cookie }, payload });
}

function errorCode(response: { json: () => unknown }) {
  return ApiError.parse(response.json()).error.code;
}

function errorMessage(response: { json: () => unknown }) {
  return ApiError.parse(response.json()).error.message;
}

function errorDetails(response: { json: () => unknown }) {
  const { limits, cycle } = ApiError.parse(response.json()).error;
  return { limits, cycle };
}

async function create(body: object = {}, key = 'WEB'): Promise<TicketDetail> {
  const response = await call('POST', `${key}/tickets`, {
    type: 'feature',
    title: 'A ticket',
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return TicketDetail.parse(response.json());
}

async function ticket(number: number, key = 'WEB'): Promise<TicketDetail> {
  const response = await call('GET', `${key}/tickets/${String(number)}`);
  expect(response.statusCode, response.body).toBe(200);
  return TicketDetail.parse(response.json());
}

async function board(key = 'WEB') {
  const response = await call('GET', `${key}/tickets`);
  expect(response.statusCode, response.body).toBe(200);
  return TicketListResponse.parse(response.json()).tickets;
}

/** Puts a ticket in a state no lot 1 action reaches (plans, runs and reviews come later). */
async function seedStatus(number: number, status: TicketStatus) {
  await t.db.update(schema.tickets).set({ status }).where(eq(schema.tickets.number, number));
}

async function events(type?: string) {
  const rows = await t.db.select().from(schema.events).orderBy(asc(schema.events.id));
  return rows.filter((row) => row.entityType === 'ticket' && (!type || row.type === type));
}

const actionPath: Record<OwnerTicketAction, string> = {
  cancel: 'cancel',
  mark_done: 'mark-done',
  reopen: 'reopen',
  accept: 'accept',
  reject: 'reject',
  request_changes: 'request-changes',
  skip_review: 'skip-review',
};

function act(number: number, action: OwnerTicketAction, comment = 'Done outside the Orchestrator') {
  return call(
    'POST',
    `WEB/tickets/${String(number)}/${actionPath[action]}`,
    action === 'mark_done' || action === 'request_changes' ? { comment } : undefined,
  );
}

describe('creating tickets', () => {
  it('creates a ticket in todo, numbered from 1, with its event', async () => {
    const first = await create({
      type: 'bug',
      title: ' Fix the menu ',
      description: 'It *closes* too early',
      acceptanceCriteria: ['The menu stays open', 'A test covers it'],
      priority: 'high',
    });
    expect(first).toMatchObject({
      projectKey: 'WEB',
      number: 1,
      type: 'bug',
      title: 'Fix the menu',
      description: 'It *closes* too early',
      acceptanceCriteria: ['The menu stays open', 'A test covers it'],
      priority: 'high',
      status: 'todo',
      blocked: false,
      assignee: null,
      createdBy: 'owner',
      blockedBy: [],
      blocks: [],
      timeline: [],
    });
    expect((await create()).number).toBe(2);

    const created = await events('ticket.created');
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      actor: 'owner',
      entityId: first.id,
      payload: { project: 'WEB', ticket: 'WEB-1', status: 'todo', blockedBy: [], assignee: null },
    });
  });

  it('numbers each project on its own', async () => {
    await seedProject('APP');
    await create();
    await create();
    expect((await create({}, 'APP')).number).toBe(1);
    expect((await ticket(1, 'APP')).projectKey).toBe('APP');
  });

  it('gives every ticket its own number under concurrent creation', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', 'WEB/tickets', { type: 'chore', title: `Ticket ${String(i)}` }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(20).fill(201));
    const numbers = responses.map((response) => TicketDetail.parse(response.json()).number);
    expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('never reuses a number, even of a cancelled ticket', async () => {
    await create();
    await create();
    expect((await act(2, 'cancel')).statusCode).toBe(200);
    expect((await create()).number).toBe(3);
  });

  it('refuses a missing title, an unknown type and a status chosen by the client', async () => {
    for (const body of [
      { type: 'feature', title: ' ' },
      { type: 'epic', title: 'T' },
      { type: 'feature', title: 'T', status: 'done' },
    ]) {
      const response = await call('POST', 'WEB/tickets', body);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('invalid_request');
    }
    expect(await board()).toEqual([]);
  });

  it('applies the length and count limits of the settings', async () => {
    await t.close();
    await start({
      ticketTitleMaxLength: 10,
      ticketDescriptionMaxLength: 20,
      ticketMaxAcceptanceCriteria: 2,
      acceptanceCriterionMaxLength: 5,
    });
    await seedProject('WEB');
    for (const [body, problem] of [
      [{ title: 'x'.repeat(11) }, 'title: at most 10 characters'],
      [{ description: 'x'.repeat(21) }, 'description: at most 20 characters'],
      [{ acceptanceCriteria: ['a', 'b', 'c'] }, 'acceptanceCriteria: at most 2'],
      [{ acceptanceCriteria: ['a', 'bbbbbb'] }, 'acceptanceCriteria.1: at most 5 characters'],
    ] as const) {
      const response = await call('POST', 'WEB/tickets', { type: 'feature', title: 'T', ...body });
      expect(response.statusCode).toBe(400);
      expect(errorMessage(response)).toBe(problem);
    }
    // The refusal names each field and its limit, for the UI.
    const all = await call('POST', 'WEB/tickets', {
      type: 'feature',
      title: 'x'.repeat(11),
      acceptanceCriteria: ['a', 'bbbbbb', 'c'],
    });
    expect(errorDetails(all).limits).toEqual([
      { field: 'title', max: 10, unit: 'characters' },
      { field: 'acceptance_criteria', max: 2, unit: 'items' },
      { field: 'acceptance_criterion', index: 1, max: 5, unit: 'characters' },
    ]);
    await create({ title: 'x'.repeat(10), acceptanceCriteria: ['a', 'bbbbb'] });

    const edit = await call('PATCH', 'WEB/tickets/1', { title: 'x'.repeat(11) });
    expect(edit.statusCode).toBe(400);
    expect((await ticket(1)).title).toBe('x'.repeat(10));
  });

  it('refuses tickets on a project that does not exist, is archived or is not ready', async () => {
    await seedProject('OLD', { status: 'archived' });
    await seedProject('NEW', { setupStatus: 'in_progress', setupStep: 'skeleton' });
    await seedProject('BAD', { setupStatus: 'failed', setupStep: 'repository', setupFailure: 'x' });
    const refusals = {
      NOPE: 'project_not_found',
      nope: 'project_not_found',
      OLD: 'project_archived',
      NEW: 'project_not_ready',
      BAD: 'project_not_ready',
    };
    for (const [key, code] of Object.entries(refusals)) {
      const response = await call('POST', `${key}/tickets`, { type: 'feature', title: 'T' });
      expect(errorCode(response), key).toBe(code);
    }
    expect(await t.db.select().from(schema.tickets)).toEqual([]);
  });

  it('accepts tickets on a linked project whatever harness elements it misses', async () => {
    await seedProject('LEG', {
      repoOrigin: 'linked',
      branchProtection: 'not_applied',
      missingHarness: ['claude_md', 'user_docs', 'dev_docs', 'adrs', 'ci_workflow'],
      harnessCheckedAt: new Date(),
    });
    expect((await create({}, 'LEG')).number).toBe(1);
  });

  it('creates a ticket with its dependencies, which must exist in the project', async () => {
    await seedProject('APP');
    await create({}, 'APP');
    await create();
    await create();
    const third = await create({ blockedBy: [1, 2, 2] });
    expect(third.blockedBy.map((link) => link.number)).toEqual([1, 2]);
    expect(third.blocked).toBe(true);
    expect((await events('ticket.created'))[3]?.payload).toMatchObject({
      blockedBy: ['WEB-1', 'WEB-2'],
    });

    const unknown = await call('POST', 'WEB/tickets', { type: 'bug', title: 'T', blockedBy: [9] });
    expect(unknown.statusCode).toBe(422);
    expect(errorCode(unknown)).toBe('ticket_not_found');
    expect(errorMessage(unknown)).toBe('No ticket WEB-9 in this project');
    expect((await board()).length).toBe(3);
  });

  it('requires a session', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/projects/WEB/tickets' });
    expect(response.statusCode).toBe(401);
  });
});

describe('the board', () => {
  it('lists tickets by state, then priority, with the blocked flag', async () => {
    await create({ title: 'One' });
    await create({ title: 'Two', priority: 'high', blockedBy: [1] });
    await create({ title: 'Three', priority: 'low' });
    await create({ title: 'Four' });
    await seedStatus(4, 'proposed');
    await act(3, 'cancel');

    const tickets = await board();
    expect(tickets.map((row) => [row.number, row.status, row.blocked])).toEqual([
      [4, 'proposed', false],
      [2, 'todo', true],
      [1, 'todo', false],
      [3, 'cancelled', false],
    ]);
  });

  it('counts the tickets of each project per state in the project list', async () => {
    await seedProject('APP');
    await create();
    await create();
    await create();
    await act(3, 'cancel');
    await create({}, 'APP');
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie },
    });
    const counts = Object.fromEntries(
      ProjectListResponse.parse(response.json()).projects.map((p) => [p.key, p.ticketCounts]),
    );
    const none = Object.fromEntries(TicketStatus.options.map((status) => [status, 0]));
    expect(counts).toEqual({
      WEB: { ...none, todo: 2, cancelled: 1 },
      APP: { ...none, todo: 1 },
    });
  });
});

describe('owner actions on the status (04, section 2)', () => {
  const cases = TicketStatus.options.flatMap((from) =>
    (Object.keys(OWNER_TRANSITIONS) as OwnerTicketAction[]).map((action) => ({
      from,
      action,
      to: OWNER_TRANSITIONS[action].from.includes(from) ? OWNER_TRANSITIONS[action].to : null,
    })),
  );

  it('covers the table: cancel from any non-terminal state, done by hand except from proposed, reopen from cancelled', () => {
    const allowed = cases.filter((c) => c.to !== null).map((c) => `${c.action}:${c.from}`);
    expect(allowed.sort()).toEqual(
      [
        ...['proposed', 'todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge'].map(
          (from) => `cancel:${from}`,
        ),
        ...['todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge'].map(
          (from) => `mark_done:${from}`,
        ),
        'reopen:cancelled',
        'accept:proposed',
        'reject:proposed',
        'request_changes:in_review',
        'skip_review:in_review',
      ].sort(),
    );
  });

  // Accept and Reject need a ticket an agent proposed: tested in mcp.test.ts.
  it.each(cases.filter((c) => c.to !== null && c.action !== 'accept' && c.action !== 'reject'))(
    '$action from $from gives $to, with its event and timeline entry',
    async ({ from, action, to }) => {
      await create();
      await seedStatus(1, from);
      const response = await act(1, action);
      expect(response.statusCode, response.body).toBe(200);
      const result = TicketDetail.parse(response.json());
      expect(result.status).toBe(to);

      const [event] = await events('ticket.status_changed');
      expect(event).toMatchObject({
        actor: 'owner',
        entityId: result.id,
        payload: { project: 'WEB', ticket: 'WEB-1', from, to, action },
      });
      const change = result.timeline.find((entry) => entry.type === 'status_change');
      expect(change).toMatchObject({ actor: 'owner', from, to });

      const comments = await t.db.select().from(schema.comments);
      if (action === 'mark_done' || action === 'request_changes') {
        expect(comments).toMatchObject([
          { author: 'owner', kind: 'status_change', body: 'Done outside the Orchestrator' },
        ]);
        expect(change).toMatchObject({ commentId: comments[0]?.id });
        expect(event?.payload).toMatchObject({ commentId: comments[0]?.id });
      } else if (action === 'skip_review') {
        expect(comments).toMatchObject([
          { author: 'system', kind: 'status_change', body: 'The owner skipped the review.' },
        ]);
        expect(event?.payload).toMatchObject({ commentId: comments[0]?.id });
      } else {
        expect(comments).toEqual([]);
      }
    },
  );

  it.each(cases.filter((c) => c.to === null))(
    '$action from $from is refused with an explanation, and nothing changes',
    async ({ from, action }) => {
      await create();
      await seedStatus(1, from);
      const response = await act(1, action);
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('ticket_transition_not_allowed');
      expect(errorMessage(response)).not.toBe('');
      expect((await ticket(1)).status).toBe(from);
      expect(await events('ticket.status_changed')).toEqual([]);
      expect(await t.db.select().from(schema.comments)).toEqual([]);
    },
  );

  it('explains the refusals in words', async () => {
    await create();
    await seedStatus(1, 'proposed');
    expect(errorMessage(await act(1, 'mark_done'))).toMatch(/not accepted yet/);
    await seedStatus(1, 'done');
    expect(errorMessage(await act(1, 'cancel'))).toBe(
      'Cancel is not possible for a ticket in done: only from proposed, todo, in_progress, waiting_human, in_review, awaiting_merge',
    );
    expect(errorMessage(await act(1, 'mark_done'))).toBe('The ticket is already done');
  });

  it('refuses to mark as done without a comment', async () => {
    await create();
    for (const payload of [undefined, {}, { comment: '   ' }]) {
      const response = await call('POST', 'WEB/tickets/1/mark-done', payload);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('invalid_request');
    }
    expect((await ticket(1)).status).toBe('todo');
    expect(await events('ticket.status_changed')).toEqual([]);
  });

  it('refuses to request changes without a comment, and keeps the attempt count', async () => {
    await create();
    await seedStatus(1, 'in_review');
    await t.db.update(schema.tickets).set({ attemptCount: 1 }).where(eq(schema.tickets.number, 1));
    for (const payload of [undefined, {}, { comment: '   ' }]) {
      const response = await call('POST', 'WEB/tickets/1/request-changes', payload);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('invalid_request');
    }
    expect((await ticket(1)).status).toBe('in_review');
    const response = await act(1, 'request_changes', 'The button is still blue');
    expect(response.statusCode, response.body).toBe(200);
    expect(TicketDetail.parse(response.json())).toMatchObject({ status: 'todo', attemptCount: 1 });
  });

  it('writes nothing when a part of mark as done fails', async () => {
    await create();
    // The status change's event fails: its comment and status must not stay behind.
    await t.pool.query(`
      CREATE FUNCTION refuse_event() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'event refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_status_event BEFORE INSERT ON events FOR EACH ROW
      WHEN (NEW.type = 'ticket.status_changed') EXECUTE FUNCTION refuse_event();
    `);
    const response = await act(1, 'mark_done');
    expect(response.statusCode).toBe(500);
    expect((await ticket(1)).status).toBe('todo');
    expect(await t.db.select().from(schema.comments)).toEqual([]);
  });

  it('unblocks the tickets a ticket marked as done was blocking; a cancelled one still blocks', async () => {
    await create();
    await create();
    await create({ blockedBy: [1, 2] });
    await act(1, 'mark_done');
    expect((await ticket(3)).blocked).toBe(true);
    await act(2, 'cancel');
    expect((await ticket(3)).blocked).toBe(true);
    await act(2, 'reopen');
    await act(2, 'mark_done');
    expect((await ticket(3)).blocked).toBe(false);
    expect((await board()).find((row) => row.number === 3)?.blocked).toBe(false);
  });

  it('keeps the number, history and dependencies of a reopened ticket', async () => {
    await create();
    await create({ blockedBy: [1] });
    await call('POST', 'WEB/tickets/2/comments', { body: 'Before' });
    await act(2, 'cancel');
    const reopened = TicketDetail.parse((await act(2, 'reopen')).json());
    expect(reopened).toMatchObject({ number: 2, status: 'todo', blocked: true });
    expect(reopened.blockedBy.map((link) => link.number)).toEqual([1]);
    expect(reopened.timeline.map((entry) => entry.type)).toEqual([
      'comment',
      'status_change',
      'status_change',
    ]);
  });

  it('refuses status changes on an archived project', async () => {
    await create();
    await t.db.update(schema.projects).set({ status: 'archived' });
    for (const action of ['cancel', 'mark_done'] as const) {
      expect(errorCode(await act(1, action))).toBe('project_archived');
    }
    expect((await ticket(1)).status).toBe('todo');
  });

  it('refuses an unknown ticket', async () => {
    for (const number of ['9', '0', 'x', '01', '99999999999']) {
      const response = await call('POST', `WEB/tickets/${number}/cancel`);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('ticket_not_found');
    }
  });
});

describe('editing tickets', () => {
  it.each(['proposed', 'todo'] as const)('edits a ticket in %s, with its event', async (status) => {
    await create({ title: 'Old', acceptanceCriteria: ['A'] });
    await seedStatus(1, status);
    const response = await call('PATCH', 'WEB/tickets/1', {
      title: 'New',
      acceptanceCriteria: ['A'],
      priority: 'high',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(TicketDetail.parse(response.json())).toMatchObject({
      title: 'New',
      priority: 'high',
      status,
    });
    const [event] = await events('ticket.updated');
    expect(event?.payload).toEqual({
      project: 'WEB',
      ticket: 'WEB-1',
      fields: ['title', 'priority'],
      title: 'New',
      priority: 'high',
    });
  });

  it('writes no event when nothing changes', async () => {
    await create({ title: 'Same' });
    expect((await call('PATCH', 'WEB/tickets/1', { title: 'Same' })).statusCode).toBe(200);
    expect(await events('ticket.updated')).toEqual([]);
  });

  it.each([
    'in_progress',
    'waiting_human',
    'in_review',
    'awaiting_merge',
    'done',
    'cancelled',
  ] as const)('refuses to edit a ticket in %s', async (status) => {
    await create({ title: 'Old' });
    await seedStatus(1, status);
    const response = await call('PATCH', 'WEB/tickets/1', { title: 'New' });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('ticket_not_editable');
    expect((await ticket(1)).title).toBe('Old');
  });

  it('never changes the status through an edit', async () => {
    await create();
    const response = await call('PATCH', 'WEB/tickets/1', { status: 'done' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses edits on an archived project', async () => {
    await create({ title: 'Old' });
    await t.db.update(schema.projects).set({ status: 'archived' });
    expect(errorCode(await call('PATCH', 'WEB/tickets/1', { title: 'New' }))).toBe(
      'project_archived',
    );
  });
});

describe('assignee (01, section 3.4)', () => {
  const webDev = { key: 'web_dev', name: 'Web Developer' };
  const architect = { key: 'architect', name: 'Architect' };

  it('creates a ticket with an assignee, shown on the board and the ticket, with its event', async () => {
    const created = await create({ assignee: 'web_dev' });
    expect(created.assignee).toEqual(webDev);
    expect((await board())[0]?.assignee).toEqual(webDev);
    expect((await ticket(1)).assignee).toEqual(webDev);
    const [event] = await events('ticket.created');
    expect(event?.payload).toMatchObject({ assignee: 'web_dev', assigneeName: 'Web Developer' });
  });

  it.each(['proposed', 'todo'] as const)(
    'changes and removes the assignee of a ticket in %s, with its events',
    async (status) => {
      await create({ assignee: 'web_dev' });
      await seedStatus(1, status);
      const changed = await call('PATCH', 'WEB/tickets/1', { assignee: 'architect' });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(TicketDetail.parse(changed.json()).assignee).toEqual(architect);
      const removed = await call('PATCH', 'WEB/tickets/1', { assignee: null });
      expect(TicketDetail.parse(removed.json()).assignee).toBeNull();
      expect((await events('ticket.updated')).map((event) => event.payload)).toEqual([
        {
          project: 'WEB',
          ticket: 'WEB-1',
          fields: ['assignee'],
          assignee: 'architect',
          assigneeName: 'Architect',
        },
        { project: 'WEB', ticket: 'WEB-1', fields: ['assignee'], assignee: null },
      ]);
    },
  );

  it('writes no event when the assignee does not change', async () => {
    await create({ assignee: 'web_dev' });
    expect((await call('PATCH', 'WEB/tickets/1', { assignee: 'web_dev' })).statusCode).toBe(200);
    await create();
    expect((await call('PATCH', 'WEB/tickets/2', { assignee: null })).statusCode).toBe(200);
    expect(await events('ticket.updated')).toEqual([]);
  });

  it('names the other fields changed with the assignee in one event', async () => {
    await create({ title: 'Old' });
    await call('PATCH', 'WEB/tickets/1', { title: 'New', assignee: 'web_dev' });
    const [event] = await events('ticket.updated');
    expect(event?.payload).toEqual({
      project: 'WEB',
      ticket: 'WEB-1',
      fields: ['title', 'assignee'],
      title: 'New',
      assignee: 'web_dev',
      assigneeName: 'Web Developer',
    });
  });

  it.each([
    'in_progress',
    'waiting_human',
    'in_review',
    'awaiting_merge',
    'done',
    'cancelled',
  ] as const)('refuses to change the assignee of a ticket in %s', async (status) => {
    await create({ assignee: 'web_dev' });
    await seedStatus(1, status);
    for (const assignee of ['architect', null]) {
      const response = await call('PATCH', 'WEB/tickets/1', { assignee });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('ticket_not_editable');
    }
    expect((await ticket(1)).assignee).toEqual(webDev);
    expect(await events('ticket.updated')).toEqual([]);
  });

  it('refuses Quality as assignee, when creating and when editing: a reviewer never implements (03, section 4)', async () => {
    const refused = await call('POST', 'WEB/tickets', {
      type: 'feature',
      title: 'A ticket',
      assignee: 'quality',
    });
    expect(refused.statusCode).toBe(422);
    expect(errorCode(refused)).toBe('agent_not_assignable');
    expect(errorMessage(refused)).toBe(
      'Quality reviews the work of other agents and cannot be assigned a ticket',
    );
    expect(await board()).toEqual([]);

    await create({ title: 'Old', assignee: 'web_dev' });
    const edit = await call('PATCH', 'WEB/tickets/1', { assignee: 'quality' });
    expect(edit.statusCode).toBe(422);
    expect(errorCode(edit)).toBe('agent_not_assignable');
    expect(await ticket(1)).toMatchObject({ assignee: webDev });
  });

  it('refuses an unknown profile, when creating and when editing, and changes nothing', async () => {
    const refused = await call('POST', 'WEB/tickets', {
      type: 'feature',
      title: 'A ticket',
      assignee: 'designer',
    });
    expect(refused.statusCode).toBe(422);
    expect(errorCode(refused)).toBe('agent_not_found');
    expect(errorMessage(refused)).toBe('No agent profile with the key designer');
    expect(await board()).toEqual([]);

    await create({ title: 'Old', assignee: 'web_dev' });
    const edit = await call('PATCH', 'WEB/tickets/1', { title: 'New', assignee: 'designer' });
    expect(edit.statusCode).toBe(422);
    expect(errorCode(edit)).toBe('agent_not_found');
    expect(await ticket(1)).toMatchObject({ title: 'Old', assignee: webDev });
    expect(await events('ticket.updated')).toEqual([]);

    const malformed = await call('PATCH', 'WEB/tickets/1', { assignee: 'Web Developer' });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('dependencies', () => {
  function depend(number: number, blockedBy: number) {
    return call('POST', `WEB/tickets/${String(number)}/dependencies`, { blockedBy });
  }

  it('adds a dependency, shown on both tickets, with its event', async () => {
    await create({ title: 'Base' });
    await create({ title: 'Top' });
    const response = await depend(2, 1);
    expect(response.statusCode, response.body).toBe(200);
    expect(TicketDetail.parse(response.json())).toMatchObject({
      blocked: true,
      blockedBy: [{ number: 1, title: 'Base', status: 'todo' }],
    });
    expect((await ticket(1)).blocks).toEqual([{ number: 2, title: 'Top', status: 'todo' }]);
    expect((await events('ticket.dependency_added'))[0]?.payload).toEqual({
      project: 'WEB',
      ticket: 'WEB-2',
      blockedBy: 'WEB-1',
    });

    // Adding it again changes nothing.
    expect((await depend(2, 1)).statusCode).toBe(200);
    expect(await events('ticket.dependency_added')).toHaveLength(1);
  });

  it('removes a dependency, with its event', async () => {
    await create();
    await create({ blockedBy: [1] });
    const response = await call('DELETE', 'WEB/tickets/2/dependencies/1');
    expect(response.statusCode, response.body).toBe(200);
    expect(TicketDetail.parse(response.json())).toMatchObject({ blocked: false, blockedBy: [] });
    expect(await events('ticket.dependency_removed')).toHaveLength(1);

    const again = await call('DELETE', 'WEB/tickets/2/dependencies/1');
    expect(again.statusCode).toBe(404);
    expect(errorCode(again)).toBe('dependency_not_found');
  });

  it('refuses a dependency on itself or on a ticket of another project', async () => {
    await seedProject('APP');
    await create({}, 'APP');
    await create({}, 'APP');
    await create();
    const itself = await depend(1, 1);
    expect(itself.statusCode).toBe(422);
    expect(errorCode(itself)).toBe('dependency_on_itself');
    // WEB has no ticket 2: APP-2 is never reached from WEB.
    const other = await depend(1, 2);
    expect(other.statusCode).toBe(422);
    expect(errorCode(other)).toBe('ticket_not_found');
  });

  it('refuses a cycle of two, naming it', async () => {
    await create();
    await create({ blockedBy: [1] });
    const response = await depend(1, 2);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('dependency_cycle');
    expect(errorMessage(response)).toBe(
      'This dependency would make WEB-1 wait for itself: WEB-1 → WEB-2 → WEB-1 (each waits for the next)',
    );
    expect(errorDetails(response).cycle).toEqual(['WEB-1', 'WEB-2', 'WEB-1']);
  });

  it('refuses a longer cycle, naming every ticket in it', async () => {
    await create();
    await create({ blockedBy: [1] });
    await create({ blockedBy: [2] });
    await create({ blockedBy: [3] });
    await create();
    await depend(4, 5); // A branch that is not part of the cycle.
    const response = await depend(1, 4);
    expect(errorCode(response)).toBe('dependency_cycle');
    expect(errorMessage(response)).toContain('WEB-1 → WEB-4 → WEB-3 → WEB-2 → WEB-1');
    expect(errorDetails(response).cycle).toEqual(['WEB-1', 'WEB-4', 'WEB-3', 'WEB-2', 'WEB-1']);
    expect((await ticket(1)).blockedBy).toEqual([]);
    // Ticket 1 may still wait for ticket 5: no cycle.
    expect((await depend(1, 5)).statusCode).toBe(200);
  });

  it('never accepts both directions of a dependency added at the same time', async () => {
    for (let round = 0; round < 10; round++) {
      const a = (await create()).number;
      const b = (await create()).number;
      const responses = await Promise.all([depend(a, b), depend(b, a)]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    }
    const rows = await t.db.select().from(schema.ticketDependencies);
    expect(rows).toHaveLength(10);
  });

  it('changes dependencies only while the waiting ticket is proposed or todo; the blocking one can be in any state', async () => {
    await create();
    await create();
    await seedStatus(1, 'done');
    await seedStatus(2, 'proposed');
    expect((await depend(2, 1)).statusCode).toBe(200);

    for (const status of [
      'in_progress',
      'waiting_human',
      'in_review',
      'awaiting_merge',
      'done',
      'cancelled',
    ] as const) {
      await seedStatus(2, status);
      const added = await depend(2, 1);
      expect(added.statusCode, status).toBe(409);
      expect(errorCode(added)).toBe('ticket_not_editable');
      expect(errorCode(await call('DELETE', 'WEB/tickets/2/dependencies/1'))).toBe(
        'ticket_not_editable',
      );
    }
    expect((await ticket(2)).blockedBy).toHaveLength(1);
  });

  it('refuses dependency changes on an archived project', async () => {
    await create();
    await create();
    await t.db.update(schema.projects).set({ status: 'archived' });
    expect(errorCode(await depend(2, 1))).toBe('project_archived');
  });
});

describe('comments', () => {
  function comment(number: number, body: string) {
    return call('POST', `WEB/tickets/${String(number)}/comments`, { body });
  }

  it('adds owner notes to the timeline, with their event', async () => {
    await create();
    const response = await comment(1, 'First **note**');
    expect(response.statusCode, response.body).toBe(201);
    await comment(1, 'Second');
    const { timeline } = await ticket(1);
    expect(
      timeline.map((entry) => entry.type === 'comment' && [entry.comment.kind, entry.comment.body]),
    ).toEqual([
      ['note', 'First **note**'],
      ['note', 'Second'],
    ]);
    const [event] = await events('ticket.commented');
    expect(event?.payload).toMatchObject({ project: 'WEB', ticket: 'WEB-1', kind: 'note' });
  });

  it.each(['proposed', 'in_review', 'done', 'cancelled'] as const)(
    'accepts notes on a ticket in %s',
    async (status) => {
      await create();
      await seedStatus(1, status);
      expect((await comment(1, 'Still a note')).statusCode).toBe(201);
    },
  );

  it('refuses an empty note, a note over the limit and notes on an archived project', async () => {
    await t.close();
    await start({ commentMaxLength: 5 });
    await seedProject('WEB');
    await create();
    expect((await comment(1, '  ')).statusCode).toBe(400);
    expect(errorMessage(await comment(1, 'x'.repeat(6)))).toBe('body: at most 5 characters');
    const markDone = await act(1, 'mark_done', 'x'.repeat(6));
    expect(errorMessage(markDone)).toBe('comment: at most 5 characters');
    expect(errorDetails(markDone).limits).toEqual([
      { field: 'comment', max: 5, unit: 'characters' },
    ]);
    await t.db.update(schema.projects).set({ status: 'archived' });
    expect(errorCode(await comment(1, 'Note'))).toBe('project_archived');
    expect(await t.db.select().from(schema.comments)).toEqual([]);
  });

  it('keeps the timeline in order of time', async () => {
    await create();
    await comment(1, 'Before');
    await act(1, 'mark_done', 'Shipped by hand');
    const kinds = (await ticket(1)).timeline.map((entry) =>
      entry.type === 'comment' ? entry.comment.body : `${entry.from}→${entry.to}`,
    );
    expect(kinds.slice(0, 1)).toEqual(['Before']);
    expect(new Set(kinds.slice(1))).toEqual(new Set(['todo→done', 'Shipped by hand']));
    const rows = await t.db
      .select()
      .from(schema.comments)
      .where(and(eq(schema.comments.kind, 'status_change')));
    expect(rows).toHaveLength(1);
  });
});
