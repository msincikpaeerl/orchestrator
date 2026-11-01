import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  Project,
  QueueResponse,
  RequestDetail,
} from '@orchestrator/protocol';
import { asc, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { repositoryFiles, repositoryHistory } from './fake-github.js';
import { RunHarness, state } from './run-harness.js';

// A new project from a plan (01, section 3.3; 02, section 5.3; 08, sections 3.1 and 3.2; owner's
// answers, lot 5 step G): Approve with the approval form creates the project, its repository with
// the skeleton and the plan's tickets, which wait for the setup. The real application, the fake
// GitHub, scripted daemons; the tests run the scheduler's ticks.

const h = new RunHarness();
let at = new Date('2026-11-03T10:00:00Z');
const clock = () => at;

afterEach(async () => {
  await h.stop();
  at = new Date('2026-11-03T10:00:00Z');
});

const setup = {
  key: 'setup',
  type: 'chore',
  title: 'Set up the project',
  acceptance_criteria: ['The home page says hello'],
  assignee: 'architect',
  bootstrap: true,
};
const contact = {
  key: 'contact',
  type: 'feature',
  title: 'Contact form',
  acceptance_criteria: ['A message is saved'],
  assignee: 'web_dev',
};
const PLAN = {
  summary: 'A bakery website with a contact form.',
  new_project: { name: 'Bakery shop', kind: 'website', description: 'The bakery online.' },
  tickets: [setup, contact],
};
const FORM = { name: 'Bakery shop', key: 'SHOP', repositoryName: 'bakery-shop', private: true };

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

async function request(): Promise<RequestDetail> {
  const response = await h.call('GET', '/api/requests/1');
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

async function approve(body: object): Promise<RequestDetail> {
  const response = await h.call('POST', '/api/requests/1/plan/approve', body);
  expect(response.statusCode, response.body).toBe(200);
  return RequestDetail.parse(response.json());
}

async function refused(body: object) {
  const response = await h.call('POST', '/api/requests/1/plan/approve', body);
  return { status: response.statusCode, error: ApiError.parse(response.json()).error };
}

async function project(key = 'SHOP'): Promise<Project> {
  const response = await h.call('GET', `/api/projects/${key}`);
  expect(response.statusCode, response.body).toBe(200);
  return Project.parse(response.json());
}

/** The project once its setup is no longer in progress (it runs after the approval's answer). */
async function settled(key = 'SHOP'): Promise<Project> {
  for (let i = 0; i < 200; i++) {
    const current = await project(key);
    if (current.setup.status !== 'in_progress') return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`setup of ${key} did not finish`);
}

async function needsYou() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function queue() {
  return QueueResponse.parse((await h.call('GET', '/api/queue')).json()).candidates;
}

/** The fake GitHub account's permissions, changed by a test to make a setup step fail. */
function permissions() {
  const [account] = [...h.github.accounts.values()];
  if (!account) throw new Error('no GitHub account');
  return account.permissions;
}

/**
 * Request 1 for a new project, and the scheduler's planning run proposing `plan`: the request
 * waits for the owner's review.
 */
async function proposed(plan: object = PLAN): Promise<{ daemon: ScriptedDaemon; planId: string }> {
  await h.start({ now: clock });
  const created = await h.call('POST', '/api/requests', {
    body: 'A bakery website with a contact form.',
    project: null,
  });
  expect(created.statusCode, created.body).toBe(201);
  const { daemon } = await h.machine();
  at = new Date(at.getTime() + 60_000);
  expect(await tick()).toEqual(['plan Request 1 on Laptop']);
  const [run] = await h.t.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.purpose, 'plan'))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!run) throw new Error('no planning run');
  const { runToken } = await h.working(daemon, run.id);
  await h.ok(daemon, runToken, 'plan_propose', plan);
  await h.report(daemon, state(run.id, { state: 'ended', reason: 'submitted' }));
  const detail = await request();
  expect(detail.status).toBe('plan_proposed');
  if (!detail.plan) throw new Error('no plan');
  return { daemon, planId: detail.plan.id };
}

describe('Approve for a new project (answers 2 to 4)', () => {
  it('creates the project, its private repository with the skeleton, and the tickets in it', async () => {
    const { planId } = await proposed();
    const detail = await approve({ planId, project: FORM });
    expect(detail.status).toBe('closed');
    expect(detail.project).toEqual({ key: 'SHOP', name: 'Bakery shop' });
    expect(detail.plan).toMatchObject({
      status: 'approved',
      newProject: { name: 'Bakery shop', kind: 'website' },
      tickets: [
        { key: 'setup', created: { reference: 'SHOP-1', number: 1 } },
        { key: 'contact', created: { reference: 'SHOP-2', number: 2 } },
      ],
    });

    // The project as the Projects screen creates one, with the plan's kind and description.
    const ready = await settled();
    expect(ready).toMatchObject({
      name: 'Bakery shop',
      description: 'The bakery online.',
      kind: 'website',
      repository: { owner: 'octo-owner', name: 'bakery-shop', origin: 'created', private: true },
      setup: { status: 'ready' },
      requiredCapabilities: ['browser-tests'],
    });
    const repo = h.github.repository('octo-owner', 'bakery-shop');
    expect(repo.private).toBe(true);
    expect(repositoryHistory(repo)).toHaveLength(2);
    expect(repositoryFiles(repo)['CLAUDE.md']).toContain('Bakery shop');

    // The tickets in To do, numbered from 1, the bootstrap first with its fixed criteria, and
    // every other ticket waiting for it.
    const tickets = await h.t.db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.planId, planId))
      .orderBy(asc(schema.tickets.number));
    expect(tickets.map((row) => [row.number, row.title, row.status])).toEqual([
      [1, 'Set up the project', 'todo'],
      [2, 'Contact form', 'todo'],
    ]);
    expect(tickets[0]?.acceptanceCriteria).toHaveLength(9);
    const dependencies = await h.t.db.select().from(schema.ticketDependencies);
    expect(dependencies).toMatchObject([{ ticketId: tickets[1]?.id, blockedById: tickets[0]?.id }]);

    // Its events: the project created by the owner from request 1, then the plan approved.
    expect((await h.events('project.created'))[0]?.payload).toEqual({
      key: 'SHOP',
      name: 'Bakery shop',
      kind: 'website',
      origin: 'created',
      repository: 'octo-owner/bakery-shop',
      private: true,
      requiredCapabilities: ['browser-tests'],
      request: 1,
    });
    expect((await h.events('plan.approved'))[0]?.payload).toEqual({
      request: 1,
      project: 'SHOP',
      planId,
      tickets: [
        { key: 'setup', ticket: 'SHOP-1' },
        { key: 'contact', ticket: 'SHOP-2' },
      ],
      newProject: true,
    });
    expect((await h.events('request.status_changed')).at(-1)?.payload).toMatchObject({
      request: 1,
      project: 'SHOP',
      to: 'closed',
      cause: 'plan_approved',
    });
    expect((await h.events('ticket.created')).map((event) => event.payload)).toMatchObject([
      { project: 'SHOP', planId, request: 1 },
      { project: 'SHOP', planId, request: 1 },
    ]);
    expect((await h.events('project.ready')).length).toBe(1);
    expect((await needsYou()).some((item) => item.type === 'plan_to_review')).toBe(false);

    // The planning run had no project and keeps none.
    const [run] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.purpose, 'plan'));
    expect(run?.projectId).toBeNull();
  });

  it('keeps the tickets waiting for the setup, which Try again finishes; the bootstrap starts first', async () => {
    const { planId } = await proposed();
    // The skeleton's commit needs Workflows (Read and write): the setup fails there.
    permissions().workflows = 'read';
    await approve({ planId, project: FORM });
    const failed = await settled();
    expect(failed.setup).toMatchObject({ status: 'failed', step: 'skeleton' });
    expect(await needsYou()).toMatchObject([
      { type: 'project_setup_failed', project: { key: 'SHOP' }, step: 'skeleton' },
    ]);
    // The machine has no browser-tests: the requirement is removed, as the owner can.
    const removed = await h.call('PUT', '/api/projects/SHOP/required-capabilities', {
      capabilities: [],
    });
    expect(removed.statusCode, removed.body).toBe(200);

    at = new Date(at.getTime() + 60_000);
    expect(await tick()).toEqual([]);
    expect((await queue()).filter((each) => each.ticket?.projectKey === 'SHOP')).toMatchObject([
      { kind: 'implement', ticket: { number: 1 }, reason: { reason: 'project_not_ready' } },
      { kind: 'implement', ticket: { number: 2 }, reason: { reason: 'project_not_ready' } },
    ]);

    permissions().workflows = 'write';
    const retried = await h.call('POST', '/api/projects/SHOP/setup/retry');
    expect(retried.statusCode, retried.body).toBe(202);
    expect((await settled()).setup.status).toBe('ready');
    // SHOP-2 waits for SHOP-1, the bootstrap: only SHOP-1 starts.
    at = new Date(at.getTime() + 60_000);
    expect(await tick()).toEqual(['implement SHOP-1 on Laptop']);
  });

  it('refuses a key or a repository name taken, creating nothing', async () => {
    const { planId } = await proposed();
    h.github.requests.length = 0;
    expect(await refused({ planId, project: { ...FORM, key: 'WEB' } })).toMatchObject({
      status: 409,
      error: { code: 'project_key_taken' },
    });
    expect(await refused({ planId, project: { ...FORM, repositoryName: 'bakery' } })).toMatchObject(
      { status: 409, error: { code: 'repository_name_taken' } },
    );
    expect(h.github.requests.filter((each) => each.method !== 'GET')).toEqual([]);
    expect(await h.t.db.select().from(schema.projects)).toHaveLength(1);
    expect((await request()).status).toBe('plan_proposed');
    expect(await h.events('plan.approved')).toEqual([]);
  });

  it('needs the form for a new project, and refuses it for an existing one', async () => {
    const { planId } = await proposed();
    expect(await refused({ planId })).toMatchObject({
      status: 400,
      error: {
        code: 'invalid_request',
        message: expect.stringContaining('creates a project') as unknown,
      },
    });
    expect(await refused({ planId, project: { ...FORM, key: 'shop' } })).toMatchObject({
      status: 400,
      error: { code: 'invalid_request' },
    });
    expect((await request()).status).toBe('plan_proposed');

    // A plan with no new project (the request's project is the plan's): no form.
    await h.t.db.update(schema.plans).set({ newProject: null }).where(eq(schema.plans.id, planId));
    expect(await refused({ planId, project: FORM })).toMatchObject({
      status: 400,
      error: {
        code: 'invalid_request',
        message: expect.stringContaining('existing project') as unknown,
      },
    });
  });
});

describe('The bootstrap ticket at approval (answer 5)', () => {
  it('gets its fixed criteria back, refused when they pass Most acceptance criteria', async () => {
    const { planId } = await proposed();
    // The owner keeps only the bootstrap's own criteria.
    const edited = await h.call('PATCH', '/api/requests/1/plan/tickets/setup', {
      planId,
      acceptanceCriteria: ['The home page says hello', 'The page has a footer'],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const lowered = await h.call('PUT', '/api/settings/ticketMaxAcceptanceCriteria', { value: 9 });
    expect(lowered.statusCode, lowered.body).toBe(200);

    const { status, error } = await refused({ planId, project: FORM });
    expect(status).toBe(422);
    expect(error.code).toBe('plan_invalid');
    expect(error.planProblems).toEqual([
      {
        position: 1,
        key: 'setup',
        field: 'acceptanceCriteria',
        message: expect.stringContaining(
          'with the 8 fixed criteria it lacked added again. Remove some of its own criteria.',
        ) as unknown,
      },
    ]);
    expect(await h.t.db.select().from(schema.projects)).toHaveLength(1);

    const back = await h.call('PATCH', '/api/requests/1/plan/tickets/setup', {
      planId,
      acceptanceCriteria: ['The home page says hello'],
    });
    expect(back.statusCode, back.body).toBe(200);
    const detail = await approve({ planId, project: FORM });
    const bootstrap = detail.plan?.tickets[0];
    expect(bootstrap?.acceptance_criteria).toHaveLength(9);
    expect(bootstrap?.acceptance_criteria[0]).toBe('The home page says hello');
    await settled();
  });
});
