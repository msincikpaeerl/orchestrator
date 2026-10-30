import { schema } from '@orchestrator/db';
import { PlanNewProject, PlanTickets, type McpError, type McpResult } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/agents/files.js';
import { fixedCriteria } from '../src/requests/plan-propose.js';
import { startPlanningRun } from './planning-run.js';
import { RunHarness, state } from './run-harness.js';

// `plan_propose` (06, section 4.4; lot 5 step E1b): the Project Manager's plan, checked as the
// import checks its file and against the bootstrap rules, every problem listed in the agent's
// words; accepted, it is kept with its tickets on the plan, nothing is created in the project, and
// the request waits for the owner's review. The planning run is the test helper's, played by a
// scripted daemon.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

const bootstrapTemplate = (await loadTemplates()).bootstrap;
const WEBSITE_CRITERIA = fixedCriteria(bootstrapTemplate, 'website');

function refusal(result: McpResult['payload']): McpError {
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.output)}`);
  return result.error;
}

/**
 * WEB-1 and WEB-2 by the owner, request 1 (on WEB, or for a new project), and its planning run
 * working on Laptop.
 */
async function planning(
  options: Parameters<RunHarness['start']>[0] & { newProject?: boolean } = {},
) {
  const { newProject, ...start } = options;
  await h.start(start);
  await h.createTicket({ title: 'Home page' });
  await h.createTicket({ title: 'Contact form' });
  const created = await h.call('POST', '/api/requests', {
    body: 'A simple website with a home page and a contact form.',
    project: newProject ? null : 'WEB',
  });
  expect(created.statusCode, created.body).toBe(201);
  const machine = await h.machine();
  const run = await startPlanningRun(h.t.db, { request: 1, machineId: machine.id });
  await h.report(machine.daemon, state(run.runId, { state: 'working' }));
  return { ...machine, ...run };
}

const setup = {
  key: 'setup',
  type: 'chore',
  title: 'Set up the project',
  assignee: 'architect',
  acceptance_criteria: ['The home page shows the bakery name'],
  bootstrap: true,
};
const contact = {
  key: 'contact',
  type: 'feature',
  title: 'Contact form',
  description: 'Messages saved in a file.',
  acceptance_criteria: ['A message is saved', 'The visitor sees a confirmation'],
  priority: 'high',
  assignee: 'web_dev',
};
const newPlan = {
  summary: 'A one-page website with a contact form.',
  new_project: { name: 'Bakery website', kind: 'website', description: 'For the bakery.' },
  tickets: [setup, contact],
};

async function requestRow() {
  const [row] = await h.t.db.select().from(schema.requests);
  if (!row) throw new Error('no request');
  return row;
}

async function runRow(id: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (!row) throw new Error('no run');
  return row;
}

describe('plan_propose for a new project', () => {
  it('keeps the plan with the bootstrap first, its fixed criteria and every ticket waiting for it, and creates no ticket', async () => {
    const { daemon, runToken, runId } = await planning({ newProject: true });
    expect((await runRow(runId)).projectId).toBeNull();
    const own = WEBSITE_CRITERIA[5]?.toUpperCase().replace(/ /g, '  ') ?? '';
    const output = await h.ok(daemon, runToken, 'plan_propose', {
      ...newPlan,
      tickets: [
        { ...contact, blocked_by: ['setup'] },
        { key: 'about', type: 'docs', title: 'About page' },
        // One own criterion is a fixed one, written in another case and spacing.
        { ...setup, acceptance_criteria: [...setup.acceptance_criteria, own] },
      ],
    });
    const added = WEBSITE_CRITERIA.filter((_, index) => index !== 5);
    expect(output).toMatchObject({
      plan: { status: 'proposed' },
      request: { number: 1, status: 'plan_proposed', project: null },
      tickets: [
        { key: 'setup', blocked_by: [], bootstrap: true, added_criteria: added },
        { key: 'contact', blocked_by: ['setup'], bootstrap: false, added_criteria: [] },
        { key: 'about', blocked_by: ['setup'], bootstrap: false, added_criteria: [] },
      ],
      note: `Your plan for request 1 is recorded, with 3 tickets, and waits for the owner's review. End your turn now, without another tool call. The bootstrap ticket setup is first: it received ${String(added.length)} fixed criteria, and every other ticket waits for it.`,
    });

    const [plan] = await h.t.db.select().from(schema.plans);
    expect(plan).toMatchObject({
      summary: newPlan.summary,
      status: 'proposed',
      requestId: (await requestRow()).id,
    });
    expect(PlanNewProject.parse(plan?.newProject)).toEqual({
      name: 'Bakery website',
      kind: 'website',
      description: 'For the bakery.',
    });
    const tickets = PlanTickets.parse(plan?.tickets);
    expect(tickets[0]).toEqual({
      key: 'setup',
      type: 'chore',
      title: 'Set up the project',
      description: '',
      acceptance_criteria: [...setup.acceptance_criteria, own, ...added],
      priority: 'normal',
      assignee: 'architect',
      blocked_by: [],
      bootstrap: true,
    });
    expect(tickets[1]).toMatchObject({ key: 'contact', priority: 'high', assignee: 'web_dev' });
    expect(tickets[2]).toMatchObject({ key: 'about', assignee: null, description: '' });

    // Nothing in any project: only the owner's two tickets exist.
    expect(await h.t.db.select().from(schema.tickets)).toHaveLength(2);
    expect((await requestRow()).status).toBe('plan_proposed');
    expect((await runRow(runId)).decision).toBe('submitted');
    const [proposed] = await h.events('plan.proposed');
    expect(proposed).toMatchObject({
      actor: 'agent',
      entityType: 'request',
      payload: {
        request: 1,
        project: null,
        planId: plan?.id,
        tickets: 3,
        newProject: 'Bakery website',
        agent: 'pm',
        agentName: 'Project Manager',
        runId,
      },
    });
    const changes = await h.events('request.status_changed');
    expect(changes.at(-1)).toMatchObject({
      payload: { from: 'planning', to: 'plan_proposed', cause: 'plan_proposed', runId },
    });

    // One plan per run.
    expect(refusal(await h.tool(daemon, runToken, 'plan_propose', newPlan))).toEqual({
      code: 'INVALID_TRANSITION',
      message:
        'You already ended the work of this planning run with a decision: end your turn now.',
    });

    // The daemon ends the run as a submission: it succeeds, and the request keeps its plan.
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    expect((await runRow(runId)).status).toBe('succeeded');
    expect((await requestRow()).status).toBe('plan_proposed');
  });

  it('adds the web_app criterion for a web_app, and keeps a plan whose run fails after it', async () => {
    const { daemon, runToken, runId } = await planning({ newProject: true });
    const output = await h.ok(daemon, runToken, 'plan_propose', {
      ...newPlan,
      new_project: { name: 'Bakery shop', kind: 'web_app' },
    });
    const webApp = fixedCriteria(bootstrapTemplate, 'web_app');
    expect(webApp).toHaveLength(WEBSITE_CRITERIA.length + 1);
    expect(output.tickets).toMatchObject([{ key: 'setup', added_criteria: webApp }, {}]);
    const [plan] = await h.t.db.select().from(schema.plans);
    expect(plan?.newProject).toEqual({ name: 'Bakery shop', kind: 'web_app', description: '' });

    await h.report(daemon, state(runId, { state: 'ended', reason: 'crashed' }));
    expect((await runRow(runId)).status).toBe('failed');
    expect((await requestRow()).status).toBe('plan_proposed');
    expect(await h.t.db.select().from(schema.plans)).toHaveLength(1);
  });

  it('refuses the tools on the project and its tickets, which do not exist yet', async () => {
    const { daemon, runToken } = await planning({ newProject: true });
    const calls: [Parameters<RunHarness['tool']>[2], object][] = [
      ['project_get', {}],
      ['ticket_list', {}],
      ['ticket_get', { ticket: 'WEB-1' }],
      ['ticket_comments', { ticket: 'WEB-1' }],
      ['ticket_update', { ticket: 'WEB-1', title: 'Changed' }],
    ];
    for (const [tool, input] of calls) {
      expect(refusal(await h.tool(daemon, runToken, tool, input))).toEqual({
        code: 'INVALID_TRANSITION',
        message: `Request 1 asks for a new project: there is no project yet, so ${tool} has nothing to work on. Plan it with plan_propose and new_project.`,
      });
    }
    const agents = await h.ok(daemon, runToken, 'agent_list');
    expect(agents.agents).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'pm' })]));
    const read = await h.ok(daemon, runToken, 'request_get');
    expect(read.request).toMatchObject({ number: 1, project: null });
  });

  it('lists every problem at once, with its field, and accepts the plan once fixed', async () => {
    const { daemon, runToken } = await planning({ newProject: true });
    const error = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        summary: newPlan.summary,
        tickets: [
          { ...contact, assignee: 'writer', blocked_by: ['WEB-1', 'layout', 'Layout!'] },
          { key: 'contact', type: 'docs', title: 'Help page' },
        ],
      }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe(
      [
        'Your plan is not recorded. Fix every problem below, then call plan_propose again with the whole plan:',
        '- The plan, new_project: request 1 asks for a new project: give new_project, with its name, kind and description',
        '- The plan, tickets: a plan for a new project needs exactly one ticket with bootstrap true: a chore assigned to architect and blocked by nothing, which sets the project up',
        '- Ticket 2 (contact), key: the key "contact" is already the key of ticket 1: give each ticket its own key',
        '- Ticket 1 (contact), assignee: No agent profile with the key writer. Choose one of architect (Architect), web_dev (Web Developer), or leave the assignee out',
        '- Ticket 1 (contact), blocked_by: WEB-1 is a ticket number, but the request asks for a new project, which has no tickets yet: name keys of your plan',
        '- Ticket 1 (contact), blocked_by: no ticket of your plan has the key "layout"',
        '- Ticket 1 (contact), blocked_by: "Layout!" is not a key of your plan: keys are 1 to 40 lowercase letters, digits, "-" or "_"',
      ].join('\n'),
    );
    expect(error.details?.map((each) => each.field)).toEqual([
      'new_project',
      'tickets',
      'tickets[1].key',
      'tickets[0].assignee',
      'tickets[0].blocked_by',
      'tickets[0].blocked_by',
      'tickets[0].blocked_by',
    ]);
    expect(await h.t.db.select().from(schema.plans)).toEqual([]);
    expect((await requestRow()).status).toBe('planning');

    // The run goes on: the corrected plan is accepted.
    await h.ok(daemon, runToken, 'plan_propose', newPlan);
    expect((await requestRow()).status).toBe('plan_proposed');
  });

  it('refuses an Android project, two bootstrap tickets, and a bootstrap that is not a chore for the Architect waiting for nothing', async () => {
    const { daemon, runToken } = await planning({ newProject: true });
    const several = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        ...newPlan,
        new_project: { name: 'Bakery app', kind: 'android_app' },
        tickets: [setup, { ...contact, bootstrap: true }],
      }),
    );
    expect(several.message.split('\n').slice(1)).toEqual([
      '- The plan, new_project.kind: Android projects come with version 0.8.0: choose website or web_app. If the request needs an Android app, end your run with ticket_give_up, saying so',
      '- The plan, tickets: 2 tickets have bootstrap true (setup, contact): exactly one may have it',
    ]);
    const wrong = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        ...newPlan,
        tickets: [
          { ...setup, type: 'feature', assignee: 'web_dev', blocked_by: ['contact'] },
          contact,
        ],
      }),
    );
    expect(wrong.message.split('\n').slice(1)).toEqual([
      '- Ticket 1 (setup), type: the bootstrap ticket must be a chore, not a feature',
      '- Ticket 1 (setup), assignee: the bootstrap ticket must be assigned to architect',
      '- Ticket 1 (setup), blocked_by: the bootstrap ticket waits for nothing: remove its blocked_by (every other ticket waits for it)',
    ]);
  });

  it('refuses a bootstrap whose criteria, with the fixed ones, pass Most acceptance criteria, saying how many of its own it may have', async () => {
    const max = WEBSITE_CRITERIA.length + 2;
    const { daemon, runToken } = await planning({
      newProject: true,
      settings: { ticketMaxAcceptanceCriteria: max },
    });
    const error = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        ...newPlan,
        tickets: [{ ...setup, acceptance_criteria: ['One', 'Two', 'Three'] }, contact],
      }),
    );
    expect(error.message.split('\n').slice(1)).toEqual([
      `- Ticket 1 (setup), acceptance_criteria: ${String(3 + WEBSITE_CRITERIA.length)} criteria once the ${String(WEBSITE_CRITERIA.length)} fixed ones the Orchestrator adds are counted: at most ${String(max)} (setting "Most acceptance criteria"). Keep at most 2 criteria of your own besides the fixed ones`,
    ]);
    await h.ok(daemon, runToken, 'plan_propose', {
      ...newPlan,
      tickets: [{ ...setup, acceptance_criteria: ['One', 'Two'] }, contact],
    });
  });

  it('tells the agent to give up when the settings cannot hold the fixed criteria', async () => {
    const longest = Math.max(...WEBSITE_CRITERIA.map((text) => text.length));
    const { daemon, runToken } = await planning({
      newProject: true,
      settings: { ticketMaxAcceptanceCriteria: 5, acceptanceCriterionMaxLength: 100 },
    });
    const error = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        ...newPlan,
        tickets: [{ ...setup, acceptance_criteria: ['Works'] }, contact],
      }),
    );
    expect(error.message.split('\n').slice(1)).toEqual([
      `- Ticket 1 (setup), acceptance_criteria: the setting "Most acceptance criteria" (5) is too low for the fixed criteria of the bootstrap ticket, which need ${String(WEBSITE_CRITERIA.length)} criteria. Only the owner can raise it: end your run with ticket_give_up, saying so`,
      `- Ticket 1 (setup), acceptance_criteria: the setting "Longest acceptance criterion" (100) is too low for the fixed criteria of the bootstrap ticket, which need ${String(longest)} characters. Only the owner can raise it: end your run with ticket_give_up, saying so`,
    ]);
  });
});

describe('plan_propose for an existing project', () => {
  it('keeps the tickets with their dependencies on existing tickets, and creates none', async () => {
    const { daemon, runToken, runId } = await planning();
    const output = await h.ok(daemon, runToken, 'plan_propose', {
      summary: 'Save the messages of the contact form.',
      tickets: [
        { ...contact, blocked_by: ['WEB-2', 'WEB-2'] },
        { key: 'list', type: 'feature', title: 'List the messages', blocked_by: ['contact'] },
      ],
    });
    expect(output).toMatchObject({
      request: { status: 'plan_proposed', project: 'WEB' },
      tickets: [
        { key: 'contact', blocked_by: ['WEB-2'], added_criteria: [] },
        { key: 'list', blocked_by: ['contact'] },
      ],
      note: "Your plan for request 1 is recorded, with 2 tickets, and waits for the owner's review. End your turn now, without another tool call.",
    });
    const [plan] = await h.t.db.select().from(schema.plans);
    expect(plan?.newProject).toBeNull();
    expect(PlanTickets.parse(plan?.tickets).map((each) => each.bootstrap)).toEqual([false, false]);
    expect(await h.t.db.select().from(schema.tickets)).toHaveLength(2);
    expect(await h.events('ticket.created')).toHaveLength(2);
    const [proposed] = await h.events('plan.proposed');
    expect(proposed?.payload).toMatchObject({ project: 'WEB', newProject: null, runId });
  });

  it("refuses a new project, a bootstrap ticket, and the import's problems in the agent's words", async () => {
    const { daemon, runToken } = await planning({
      settings: { maxTicketsPerPlan: 2, ticketTitleMaxLength: 20 },
    });
    const error = refusal(
      await h.tool(daemon, runToken, 'plan_propose', {
        ...newPlan,
        tickets: [
          { ...setup, blocked_by: ['b'] },
          { key: 'b', type: 'feature', title: 'A title much too long here', blocked_by: ['setup'] },
          { key: 'c', type: 'bug', title: 'Fix', blocked_by: ['APP-1', 'WEB-99', 'c'] },
        ],
      }),
    );
    expect(error.message.split('\n').slice(1)).toEqual([
      '- The plan, new_project: request 1 is for the project WEB: leave new_project out',
      '- Ticket 1 (setup), bootstrap: the project WEB already exists: only a plan for a new project has a bootstrap ticket. Remove bootstrap',
      '- The plan, tickets: 3 tickets: at most 2 per plan (setting "Most tickets per plan"). Plan the first part of the work now, and say in the summary what a later request should add',
      '- Ticket 2 (b), title: too long: 26 characters, at most 20 (setting "Longest ticket title")',
      '- Ticket 3 (c), blocked_by: APP-1 belongs to another project: name keys of your plan, or tickets of WEB',
      '- Ticket 3 (c), blocked_by: there is no ticket WEB-99 in the project: use ticket_list to find its tickets',
      '- Ticket 3 (c), blocked_by: "c" is this ticket\'s own key: a ticket cannot wait for itself',
      '- Ticket 1 (setup), blocked_by: these tickets wait for each other, so none of them could ever start: setup → b → setup. Remove one of these dependencies',
    ]);
    expect(error.details?.[0]).toEqual({
      field: 'new_project',
      message: 'request 1 is for the project WEB: leave new_project out',
    });
  });
});

describe("plan_propose's state refusals", () => {
  it('refuses while a question waits, once the request is no longer planning, and on an archived project', async () => {
    const { daemon, runToken, runId } = await planning();
    const plan = { summary: 'Save messages.', tickets: [contact] };
    await h.ok(daemon, runToken, 'request_ask', { question: 'Which pages?' });
    expect(refusal(await h.tool(daemon, runToken, 'plan_propose', plan))).toEqual({
      code: 'INVALID_TRANSITION',
      message:
        'You asked the owner a question and request 1 waits for the answer: plan_propose is not possible now. End your turn; the answer arrives as your next message.',
    });
    await h.t.db.delete(schema.comments).where(eq(schema.comments.runId, runId));

    await h.t.db.update(schema.projects).set({ status: 'archived' });
    expect(refusal(await h.tool(daemon, runToken, 'plan_propose', plan))).toEqual({
      code: 'INVALID_TRANSITION',
      message:
        'The project WEB is archived: no plan can be proposed for it. End your run with ticket_give_up, saying so.',
    });
    await h.t.db.update(schema.projects).set({ status: 'active' });

    await h.t.db.update(schema.requests).set({ status: 'open' });
    expect(refusal(await h.tool(daemon, runToken, 'plan_propose', plan))).toEqual({
      code: 'INVALID_TRANSITION',
      message: 'Request 1 is open: plan_propose needs it planning. End your turn.',
    });
    expect(await h.t.db.select().from(schema.plans)).toEqual([]);
  });

  it('is refused outside a planning run', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runToken } = await h.running(daemon);
    expect(
      refusal(await h.tool(daemon, runToken, 'plan_propose', { summary: 'x', tickets: [contact] })),
    ).toEqual({
      code: 'FORBIDDEN',
      message:
        'plan_propose is only for a planning run, which plans a request; the purpose of this run is implement.',
    });
  });
});

describe("the bootstrap's fixed criteria (08, section 3.2)", () => {
  it('are one per criterion but Android, the web_app one only for a web_app, each within the default limits', () => {
    expect(WEBSITE_CRITERIA).toHaveLength(8);
    expect(fixedCriteria(bootstrapTemplate, 'web_app').at(-1)).toContain('integration tests');
    for (const text of fixedCriteria(bootstrapTemplate, 'web_app')) {
      expect(text.length).toBeLessThanOrEqual(500);
      expect(text).not.toContain('\n');
    }
  });
});
