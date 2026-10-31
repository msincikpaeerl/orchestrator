import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  PlanTickets,
  QueueResponse,
  RequestDetail,
  type RunStart,
} from '@orchestrator/protocol';
import { asc, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// The owner's review of a plan (01, section 3.3; 02, sections 4 and 5.3; owner's answers, lot 5
// step F1): edits and removals kept on the plan, Approve creating the tickets of an existing
// project, Reject with feedback planning the request again, and Close request. The real
// application, scripted daemons; the tests run the scheduler's ticks.

const h = new RunHarness();
let at = new Date('2026-11-03T10:00:00Z');
const clock = () => at;

afterEach(async () => {
  await h.stop();
  at = new Date('2026-11-03T10:00:00Z');
});

const home = {
  key: 'home',
  type: 'feature',
  title: 'Home page',
  acceptance_criteria: ['The home page shows the bakery name'],
  assignee: 'web_dev',
  blocked_by: ['WEB-1'],
};
const contact = {
  key: 'contact',
  type: 'feature',
  title: 'Contact form',
  description: 'Messages saved in a file.',
  acceptance_criteria: ['A message is saved'],
  priority: 'high',
  assignee: 'web_dev',
  blocked_by: ['home'],
};
const PLAN = { summary: 'A home page, then a contact form.', tickets: [home, contact] };

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

async function request(number = 1): Promise<RequestDetail> {
  const response = await h.call('GET', `/api/requests/${String(number)}`);
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

async function latestRun() {
  const [row] = await h.t.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.purpose, 'plan'))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!row) throw new Error('no planning run');
  return row;
}

/** The answer of a call, checked: its body as `RequestDetail`. */
async function owner(method: 'POST' | 'PATCH', url: string, body: object = {}) {
  const response = await h.call(method, url, body);
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

/** A refused call: its status and error. */
async function refused(method: 'POST' | 'PATCH', url: string, body: object = {}) {
  const response = await h.call(method, url, body);
  return { status: response.statusCode, error: ApiError.parse(response.json()).error };
}

/**
 * WEB-1 and WEB-2 by the owner, request 1 (on WEB, or for a new project), and the scheduler's
 * planning run proposing `plan`: the request waits for the owner's review.
 */
async function proposed(
  plan: object = PLAN,
  options: { project?: string | null } = {},
): Promise<{ daemon: ScriptedDaemon; planId: string; runId: string }> {
  await h.start({ now: clock });
  await h.createTicket({ title: 'Bakery name' });
  await h.createTicket({ title: 'Opening hours' });
  const created = await h.call('POST', '/api/requests', {
    body: 'A home page and a contact form.',
    project: options.project === undefined ? 'WEB' : options.project,
  });
  expect(created.statusCode, created.body).toBe(201);
  const { daemon } = await h.machine();
  return { daemon, ...(await propose(daemon, plan)) };
}

/** The scheduler starts the next planning run, which proposes `plan` and ends. */
async function propose(daemon: ScriptedDaemon, plan: object) {
  at = new Date(at.getTime() + 60_000);
  expect(await tick()).toEqual(['plan Request 1 on Laptop']);
  const run = await latestRun();
  const { runToken } = await h.working(daemon, run.id);
  await h.ok(daemon, runToken, 'plan_propose', plan);
  await h.report(daemon, state(run.id, { state: 'ended', reason: 'submitted' }));
  const detail = await request();
  expect(detail.status).toBe('plan_proposed');
  if (!detail.plan) throw new Error('no plan');
  return { planId: detail.plan.id, runId: run.id };
}

async function needsYou() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function storedTickets(planId: string) {
  const [plan] = await h.t.db.select().from(schema.plans).where(eq(schema.plans.id, planId));
  return PlanTickets.parse(plan?.tickets);
}

describe('the plan on the request page', () => {
  it('shows the plan, its tickets and what each waits for, and asks the owner to review it', async () => {
    const { planId } = await proposed();
    const detail = await request();
    expect(detail.plan).toMatchObject({
      id: planId,
      status: 'proposed',
      summary: PLAN.summary,
      newProject: null,
      ownerFeedback: null,
      decidedAt: null,
      tickets: [
        {
          key: 'home',
          assignee: 'web_dev',
          assigneeName: 'Web Developer',
          waitsFor: [{ kind: 'ticket', reference: 'WEB-1', title: 'Bakery name', status: 'todo' }],
          created: null,
        },
        {
          key: 'contact',
          priority: 'high',
          waitsFor: [{ kind: 'plan', key: 'home', title: 'Home page' }],
          created: null,
        },
      ],
    });
    expect(detail.earlierPlans).toEqual([]);

    expect((await needsYou()).filter((item) => item.type === 'plan_to_review')).toEqual([
      {
        type: 'plan_to_review',
        request: {
          number: 1,
          line: 'A home page and a contact form.',
          project: { key: 'WEB', name: 'Bakery website' },
        },
        planId,
        tickets: 2,
        since: detail.plan?.proposedAt,
      },
    ]);
    // An archived project's plan waits for no one.
    expect((await h.call('POST', '/api/projects/WEB/archive')).statusCode).toBe(200);
    expect((await needsYou()).filter((item) => item.type === 'plan_to_review')).toEqual([]);
  });
});

describe('editing the plan (answers 5, 7, 8 and 14)', () => {
  it('changes a ticket of the plan only, each field in its event, and nothing for no change', async () => {
    const { planId } = await proposed();
    const detail = await owner('PATCH', '/api/requests/1/plan/tickets/contact', {
      planId,
      title: 'Contact page',
      acceptanceCriteria: ['A message is saved', 'The visitor sees a confirmation'],
      assignee: null,
      blockedBy: ['home', 'WEB-2', 'home'],
      priority: 'high',
    });
    expect(detail.plan?.tickets[1]).toMatchObject({
      key: 'contact',
      title: 'Contact page',
      acceptance_criteria: ['A message is saved', 'The visitor sees a confirmation'],
      assignee: null,
      assigneeName: null,
      blocked_by: ['home', 'WEB-2'],
      waitsFor: [
        { kind: 'plan', key: 'home' },
        { kind: 'ticket', reference: 'WEB-2', title: 'Opening hours' },
      ],
    });
    const [updated] = await h.events('plan.ticket_updated');
    expect(updated).toMatchObject({
      actor: 'owner',
      entityType: 'request',
      payload: {
        request: 1,
        project: 'WEB',
        planId,
        key: 'contact',
        title: 'Contact page',
        changes: [
          { field: 'title', from: 'Contact form', to: 'Contact page' },
          {
            field: 'acceptanceCriteria',
            from: ['A message is saved'],
            to: ['A message is saved', 'The visitor sees a confirmation'],
          },
          { field: 'assignee', from: 'web_dev', to: null },
          { field: 'blockedBy', from: ['home'], to: ['home', 'WEB-2'] },
        ],
      },
    });
    // The same values again change nothing and write nothing.
    await owner('PATCH', '/api/requests/1/plan/tickets/contact', { planId, title: 'Contact page' });
    expect(await h.events('plan.ticket_updated')).toHaveLength(1);
    // Nothing in the project: the owner's two tickets only.
    expect(await h.t.db.select().from(schema.tickets)).toHaveLength(2);
  });

  it('refuses an edit for each problem it brings, in the owner words, and leaves the plan as it was', async () => {
    const { planId } = await proposed();
    expect((await h.call('POST', '/api/projects/WEB/tickets/2/cancel')).statusCode).toBe(200);
    const edit = (key: string, body: object) =>
      refused('PATCH', `/api/requests/1/plan/tickets/${key}`, { planId, ...body });

    expect(await edit('contact', { assignee: 'quality' })).toMatchObject({
      status: 422,
      error: {
        code: 'plan_invalid',
        planProblems: [
          {
            position: 2,
            key: 'contact',
            field: 'assignee',
            message: expect.stringMatching(
              /^Quality reviews the work of other agents and cannot be assigned a ticket\. The agents you can assign are .*web_dev \(Web Developer\)/,
            ) as unknown,
          },
        ],
      },
    });
    const problems = async (key: string, body: object) =>
      (await edit(key, body)).error.planProblems?.map((each) => each.message);
    expect(await problems('contact', { assignee: 'nobody' })).toEqual([
      expect.stringMatching(/^No agent profile with the key nobody\./),
    ]);
    expect(await problems('contact', { blockedBy: ['contact'] })).toEqual([
      'A ticket cannot wait for itself.',
    ]);
    expect(await problems('contact', { blockedBy: ['nothing', 'WEB-99', 'SHOP-1'] })).toEqual([
      'No ticket of the plan has the key “nothing”.',
      'There is no ticket WEB-99 in this project.',
      'SHOP-1 belongs to another project: a ticket can only wait for tickets of WEB.',
    ]);
    expect(await problems('home', { blockedBy: ['contact'] })).toEqual([
      'These tickets wait for each other, so none of them could ever start: home → contact → home. Remove one of these dependencies.',
    ]);
    expect(await problems('contact', { blockedBy: ['home', 'WEB-2'] })).toEqual([
      'WEB-2 is cancelled: a ticket waiting for it would never start.',
    ]);
    const long = 'x'.repeat(201);
    expect(await problems('contact', { title: long })).toEqual([
      'Too long: 201 characters, at most 200, the setting “Longest ticket title”.',
    ]);
    expect(await edit('nothing', { title: 'Other' })).toMatchObject({
      status: 404,
      error: { code: 'plan_ticket_not_found' },
    });
    expect(
      (await h.call('PATCH', '/api/requests/1/plan/tickets/contact', { planId })).statusCode,
    ).toBe(400);

    expect(await storedTickets(planId)).toMatchObject([
      { key: 'home', blocked_by: ['WEB-1'] },
      { key: 'contact', title: 'Contact form', assignee: 'web_dev', blocked_by: ['home'] },
    ]);
    expect(await h.events('plan.ticket_updated')).toEqual([]);
  });

  it('removes a ticket and takes it out of the dependencies, but never the last one', async () => {
    const { planId } = await proposed();
    const detail = await owner('POST', '/api/requests/1/plan/tickets/home/remove', { planId });
    expect(detail.plan?.tickets).toMatchObject([{ key: 'contact', blocked_by: [], waitsFor: [] }]);
    expect((await h.events('plan.ticket_removed'))[0]?.payload).toEqual({
      request: 1,
      project: 'WEB',
      planId,
      key: 'home',
      title: 'Home page',
      left: ['contact'],
    });
    expect(
      await refused('POST', '/api/requests/1/plan/tickets/contact/remove', { planId }),
    ).toMatchObject({ status: 409, error: { code: 'plan_last_ticket' } });
    expect(
      await refused('POST', '/api/requests/1/plan/tickets/home/remove', { planId }),
    ).toMatchObject({ status: 404, error: { code: 'plan_ticket_not_found' } });
    expect((await needsYou()).find((item) => item.type === 'plan_to_review')).toMatchObject({
      tickets: 1,
    });
  });

  it("keeps a new project's bootstrap ticket in its place, and approves such a plan from step G only", async () => {
    const setup = {
      key: 'setup',
      type: 'chore',
      title: 'Set up the project',
      assignee: 'architect',
      bootstrap: true,
    };
    const { planId } = await proposed(
      {
        summary: 'A bakery website.',
        new_project: { name: 'Bakery website', kind: 'website' },
        tickets: [setup, { ...contact, blocked_by: [] }],
      },
      { project: null },
    );
    const fixed = async (url: string, body: object, method: 'POST' | 'PATCH' = 'PATCH') =>
      (await refused(method, url, { planId, ...body })).error;
    expect(await fixed('/api/requests/1/plan/tickets/setup', { type: 'feature' })).toMatchObject({
      code: 'plan_bootstrap_fixed',
      message: expect.stringContaining("The bootstrap ticket's type cannot change") as unknown,
    });
    expect(
      await fixed('/api/requests/1/plan/tickets/setup', {
        assignee: 'web_dev',
        blockedBy: ['contact'],
      }),
    ).toMatchObject({
      code: 'plan_bootstrap_fixed',
      message: expect.stringContaining('assignee and dependencies cannot change') as unknown,
    });
    expect(await fixed('/api/requests/1/plan/tickets/contact', { blockedBy: [] })).toMatchObject({
      code: 'plan_bootstrap_fixed',
      message: expect.stringContaining('waits for its bootstrap ticket (setup)') as unknown,
    });
    expect(await fixed('/api/requests/1/plan/tickets/setup/remove', {}, 'POST')).toMatchObject({
      code: 'plan_bootstrap_fixed',
    });
    // Its title, description, criteria and priority can change; WEB tickets cannot be named.
    const detail = await owner('PATCH', '/api/requests/1/plan/tickets/setup', {
      planId,
      title: 'Set the website up',
      priority: 'high',
    });
    expect(detail.plan?.tickets[0]).toMatchObject({ title: 'Set the website up', bootstrap: true });
    expect(
      (
        await refused('PATCH', '/api/requests/1/plan/tickets/contact', {
          planId,
          blockedBy: ['setup', 'WEB-1'],
        })
      ).error.planProblems?.[0]?.message,
    ).toBe(
      'WEB-1 is a ticket number, but the new project has no tickets yet: wait only for tickets of the plan.',
    );

    expect(await refused('POST', '/api/requests/1/plan/approve', { planId })).toMatchObject({
      status: 409,
      error: { code: 'plan_new_project_later' },
    });
    expect((await request()).status).toBe('plan_proposed');
  });
});

describe('Approve (answers 9 and 10)', () => {
  it('creates the tickets in To do, in the plan order, from the plan, and closes the request', async () => {
    const { planId, runId } = await proposed();
    const [pm] = await h.t.db
      .select({ id: schema.agentProfiles.id })
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, 'pm'));
    const detail = await owner('POST', '/api/requests/1/plan/approve', { planId });
    expect(detail.status).toBe('closed');
    expect(detail.plan).toMatchObject({
      status: 'approved',
      tickets: [
        { key: 'home', created: { reference: 'WEB-3', number: 3 } },
        { key: 'contact', created: { reference: 'WEB-4', number: 4 } },
      ],
    });
    expect(detail.plan?.decidedAt).toBe(at.toISOString());

    const rows = await h.t.db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.planId, planId))
      .orderBy(asc(schema.tickets.number));
    expect(rows).toMatchObject([
      {
        number: 3,
        title: 'Home page',
        status: 'todo',
        createdBy: 'agent',
        createdByProfileId: pm?.id,
        createdByRunId: runId,
      },
      { number: 4, title: 'Contact form', status: 'todo', priority: 'high', createdBy: 'agent' },
    ]);
    expect((await h.ticket(3)).blockedBy.map((each) => each.number)).toEqual([1]);
    expect((await h.ticket(4)).blockedBy.map((each) => each.number)).toEqual([3]);

    const created = (await h.events('ticket.created')).slice(-2);
    expect(created.map((event) => event.payload)).toMatchObject([
      { ticket: 'WEB-3', planId, request: 1, blockedBy: ['WEB-1'] },
      { ticket: 'WEB-4', planId, request: 1, blockedBy: ['WEB-3'] },
    ]);
    expect(created[0]?.actor).toBe('owner');
    expect((await h.events('plan.approved'))[0]?.payload).toEqual({
      request: 1,
      project: 'WEB',
      planId,
      tickets: [
        { key: 'home', ticket: 'WEB-3' },
        { key: 'contact', ticket: 'WEB-4' },
      ],
    });
    expect((await h.events('request.status_changed')).at(-1)).toMatchObject({
      actor: 'owner',
      payload: { from: 'plan_proposed', to: 'closed', cause: 'plan_approved' },
    });
    expect(await h.events('tickets.imported')).toEqual([]);
    expect((await needsYou()).filter((item) => item.type === 'plan_to_review')).toEqual([]);

    // Its tickets are the scheduler's like any other; the request is planned no more.
    const queue = QueueResponse.parse((await h.call('GET', '/api/queue')).json()).candidates;
    expect(queue.some((each) => each.kind === 'plan')).toBe(false);
    expect(await refused('POST', '/api/requests/1/plan/approve', { planId })).toMatchObject({
      status: 409,
      error: { code: 'request_closed' },
    });
  });

  it('checks the plan again against the current settings and the project, creating nothing when refused', async () => {
    const { planId } = await proposed();
    const lowered = await h.call('PUT', '/api/settings/maxTicketsPerPlan', { value: 1 });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(await refused('POST', '/api/requests/1/plan/approve', { planId })).toMatchObject({
      status: 422,
      error: {
        code: 'plan_invalid',
        planProblems: [
          {
            position: null,
            field: 'tickets',
            message:
              'The plan has 2 tickets: at most 1, the setting “Most tickets per plan”. Remove some, or reject the plan with feedback.',
          },
        ],
      },
    });
    expect(await h.t.db.select().from(schema.tickets)).toHaveLength(2);
    expect((await request()).status).toBe('plan_proposed');

    // Removing one is enough; a blocker cancelled since is accepted, as plan_propose accepts it.
    await owner('POST', '/api/requests/1/plan/tickets/contact/remove', { planId });
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/cancel')).statusCode).toBe(200);
    expect((await owner('POST', '/api/requests/1/plan/approve', { planId })).status).toBe('closed');
    expect((await h.ticket(3)).blockedBy.map((each) => each.number)).toEqual([1]);
  });

  it('refuses an archived project, and a plan that is not the proposed one', async () => {
    const { planId } = await proposed();
    expect(
      await refused('POST', '/api/requests/1/plan/approve', { planId: crypto.randomUUID() }),
    ).toMatchObject({ status: 409, error: { code: 'plan_not_proposed' } });
    expect((await h.call('POST', '/api/projects/WEB/archive')).statusCode).toBe(200);
    expect(await refused('POST', '/api/requests/1/plan/approve', { planId })).toMatchObject({
      status: 409,
      error: { code: 'project_archived' },
    });
  });
});

describe('Reject with feedback (answers 2 and 11)', () => {
  it('supersedes the plan, plans the request again with the feedback, and keeps the history', async () => {
    const { daemon, planId } = await proposed();
    expect(
      (await h.call('POST', '/api/requests/1/plan/reject', { planId, feedback: '  ' })).statusCode,
    ).toBe(400);
    const detail = await owner('POST', '/api/requests/1/plan/reject', {
      planId,
      feedback: 'One ticket only, please.',
    });
    expect(detail).toMatchObject({ status: 'open', attemptCount: 0, plan: null });
    expect(detail.earlierPlans).toMatchObject([
      { id: planId, status: 'superseded', ownerFeedback: 'One ticket only, please.' },
    ]);
    expect((await h.events('plan.rejected'))[0]?.payload).toEqual({
      request: 1,
      project: 'WEB',
      planId,
      status: 'superseded',
      feedback: 'One ticket only, please.',
    });
    expect((await h.events('request.status_changed')).at(-1)?.payload).toMatchObject({
      from: 'plan_proposed',
      to: 'open',
      cause: 'plan_rejected',
    });
    expect(await h.t.db.select().from(schema.tickets)).toHaveLength(2);
    expect((await needsYou()).filter((item) => item.type === 'plan_to_review')).toEqual([]);

    // The next planning run reads the plan rejected and the feedback.
    const next = await propose(daemon, { ...PLAN, tickets: [home] });
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === next.runId,
      'run.start',
    );
    expect(start.payload.initialPrompt).toContain('One ticket only, please.');
    expect(start.payload.initialPrompt).toContain('Contact form');
    const after = await request();
    expect(after.plan).toMatchObject({ id: next.planId, status: 'proposed' });
    expect(after.earlierPlans.map((each) => each.id)).toEqual([planId]);
    // The old plan takes no write any more.
    expect(
      await refused('PATCH', '/api/requests/1/plan/tickets/home', { planId, title: 'Old' }),
    ).toMatchObject({ status: 409, error: { code: 'plan_not_proposed' } });
  });
});

describe('Close request (answer 3)', () => {
  it('stops its planning run without counting it, so its question waits no more', async () => {
    await h.start({ now: clock });
    const created = await h.call('POST', '/api/requests', { body: 'A blog.', project: 'WEB' });
    expect(created.statusCode).toBe(201);
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['plan Request 1 on Laptop']);
    const run = await latestRun();
    const { runToken } = await h.working(daemon, run.id);
    await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    await h.report(daemon, state(run.id, { state: 'waiting_human' }));
    expect((await needsYou()).some((item) => item.type === 'request_question')).toBe(true);

    at = new Date(at.getTime() + 60_000);
    const detail = await owner('POST', '/api/requests/1/close');
    expect(detail).toMatchObject({ status: 'closed', run: null, stopped: null, attemptCount: 0 });
    expect(detail.comments.at(-1)).toMatchObject({
      author: 'owner',
      kind: 'status_change',
      body: 'The owner closed the request. Its planning run was stopped; it does not count as a failed attempt. Nothing is planned for it any more.',
    });
    expect((await h.run(run.id)).status).toBe('cancelled');
    await eventually('run.stop sent', () => {
      expect(
        daemon.received.some(
          (message) => message.type === 'run.stop' && message.payload.runId === run.id,
        ),
      ).toBe(true);
    });
    expect((await h.events('request.status_changed')).at(-1)).toMatchObject({
      actor: 'owner',
      payload: { from: 'planning', to: 'closed', cause: 'closed_by_owner' },
    });
    expect((await h.events('run.status_changed')).at(-1)?.payload).toMatchObject({
      to: 'cancelled',
      cause: 'request_closed',
    });
    expect((await needsYou()).some((item) => item.type === 'request_question')).toBe(false);
    expect(await tick()).toEqual([]);
    expect(await refused('POST', '/api/requests/1/close')).toMatchObject({
      status: 409,
      error: { code: 'request_closed' },
    });
    // Still a place for the owner's notes.
    expect((await h.call('POST', '/api/requests/1/comments', { body: 'Later.' })).statusCode).toBe(
      201,
    );
  });

  it('rejects a proposed plan, and clears a stop', async () => {
    const { planId } = await proposed();
    at = new Date(at.getTime() + 60_000);
    const detail = await owner('POST', '/api/requests/1/close');
    expect(detail.plan).toBeNull();
    expect(detail.earlierPlans).toMatchObject([
      { id: planId, status: 'rejected', ownerFeedback: null },
    ]);
    expect(detail.comments.at(-1)?.body).toBe(
      'The owner closed the request. Its proposed plan is rejected. Nothing is planned for it any more.',
    );
    expect((await h.events('plan.rejected'))[0]?.payload).toMatchObject({
      status: 'rejected',
      feedback: null,
    });
    expect(
      await refused('POST', '/api/requests/1/plan/reject', { planId, feedback: 'No.' }),
    ).toMatchObject({ status: 409, error: { code: 'request_closed' } });
    expect((await needsYou()).filter((item) => item.type === 'plan_to_review')).toEqual([]);

    const second = await h.call('POST', '/api/requests', { body: 'A blog.', project: 'WEB' });
    expect(second.statusCode).toBe(201);
    await h.t.db
      .update(schema.requests)
      .set({ stopped: { cause: 'failed_attempts', count: 2, limit: 2, at: at.toISOString() } })
      .where(eq(schema.requests.number, 2));
    expect((await needsYou()).some((item) => item.type === 'planning_stopped')).toBe(true);
    expect((await owner('POST', '/api/requests/2/close')).stopped).toBeNull();
    expect((await needsYou()).some((item) => item.type === 'planning_stopped')).toBe(false);
  });
});
