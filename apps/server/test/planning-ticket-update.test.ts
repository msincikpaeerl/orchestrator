import { schema } from '@orchestrator/db';
import { SETTINGS, type McpError, type McpResult } from '@orchestrator/protocol';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { startPlanningRun } from './planning-run.js';
import { RunHarness, state } from './run-harness.js';

// `ticket_update` in a planning run (06, section 4.3; owner's answer 8, lot 5 step E1): the
// Project Manager changes a `proposed` or `todo` ticket of its project, within the owner's form
// limits, with the owner's edit's events naming the agent and its run. The planning run is the
// test helper's, played by a scripted daemon.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

function refusal(result: McpResult['payload']): McpError {
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.output)}`);
  return result.error;
}

/** WEB-1 and WEB-2 by the owner, request 1 on WEB, and its planning run working on Laptop. */
async function planning(options: Parameters<RunHarness['start']>[0] = {}) {
  await h.start(options);
  await h.createTicket({ title: 'Home page' });
  await h.createTicket({ title: 'Contact form' });
  const created = await h.call('POST', '/api/requests', {
    body: 'Messages from the contact form saved in a file.',
    project: 'WEB',
  });
  expect(created.statusCode, created.body).toBe(201);
  const machine = await h.machine();
  const run = await startPlanningRun(h.t.db, { request: 1, machineId: machine.id });
  await h.report(machine.daemon, state(run.runId, { state: 'working' }));
  return { ...machine, ...run };
}

async function ticketRow(number: number) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error(`no ticket ${String(number)}`);
  return row;
}

describe('ticket_update in a planning run', () => {
  it('changes the fields given, replaces the dependencies, and writes the events of an edit by the agent', async () => {
    const { daemon, runToken, runId } = await planning();
    const output = await h.ok(daemon, runToken, 'ticket_update', {
      ticket: 'WEB-2',
      title: 'Contact form that saves messages',
      acceptance_criteria: ['A message sent is saved in a file', 'The visitor sees a confirmation'],
      priority: 'high',
      assignee: null,
      blocked_by: ['WEB-1'],
    });
    expect(output.ticket).toMatchObject({
      number: 'WEB-2',
      title: 'Contact form that saves messages',
      status: 'todo',
      priority: 'high',
      assignee: null,
      blocked_by: [{ number: 'WEB-1' }],
    });
    const row = await ticketRow(2);
    expect(row.acceptanceCriteria).toEqual([
      'A message sent is saved in a file',
      'The visitor sees a confirmation',
    ]);
    // Unchanged fields stay as they were.
    expect(row.description).toBe('Visitors write to the bakery.');
    expect(row.type).toBe('feature');

    const agent = { agent: 'pm', agentName: 'Project Manager', runId };
    const [updated] = await h.events('ticket.updated');
    expect(updated).toMatchObject({
      actor: 'agent',
      payload: {
        project: 'WEB',
        ticket: 'WEB-2',
        ...agent,
        fields: ['title', 'acceptanceCriteria', 'priority', 'assignee'],
        title: 'Contact form that saves messages',
        priority: 'high',
        assignee: null,
      },
    });
    const [added] = await h.events('ticket.dependency_added');
    expect(added).toMatchObject({
      actor: 'agent',
      payload: { ticket: 'WEB-2', blockedBy: 'WEB-1', ...agent },
    });

    // An empty list removes the dependency, with its own event and no field change.
    await h.ok(daemon, runToken, 'ticket_update', { ticket: 'WEB-2', blocked_by: [] });
    const [removed] = await h.events('ticket.dependency_removed');
    expect(removed).toMatchObject({
      actor: 'agent',
      payload: { ticket: 'WEB-2', blockedBy: 'WEB-1', ...agent },
    });
    expect(await h.events('ticket.updated')).toHaveLength(1);

    // The same values again change nothing and write no event.
    await h.ok(daemon, runToken, 'ticket_update', { ticket: 'WEB-2', priority: 'high' });
    expect(await h.events('ticket.updated')).toHaveLength(1);
    expect(
      await h.t.db
        .select()
        .from(schema.ticketDependencies)
        .where(eq(schema.ticketDependencies.ticketId, row.id)),
    ).toEqual([]);
  });

  it('changes a proposed ticket, and an assignee to another builder', async () => {
    const { daemon, runToken } = await planning();
    await h.t.db
      .update(schema.tickets)
      .set({ status: 'proposed' })
      .where(eq(schema.tickets.number, 1));
    const output = await h.ok(daemon, runToken, 'ticket_update', {
      ticket: 'WEB-1',
      assignee: 'architect',
      type: 'chore',
    });
    expect(output.ticket).toMatchObject({
      status: 'proposed',
      type: 'chore',
      assignee: 'architect',
    });
  });

  it('refuses a ticket in progress or later, naming its state, and leaves it as it was', async () => {
    const { daemon, runToken } = await planning();
    for (const status of ['in_progress', 'in_review', 'done', 'cancelled'] as const) {
      await h.t.db.update(schema.tickets).set({ status }).where(eq(schema.tickets.number, 1));
      const error = refusal(
        await h.tool(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', title: 'Changed' }),
      );
      expect(error.code).toBe('INVALID_TRANSITION');
      expect(error.message).toBe(
        `WEB-1 is ${status}: ticket_update changes only a ticket that is proposed or todo. Leave it as it is, and say in your plan's summary what should change.`,
      );
    }
    expect((await ticketRow(1)).title).toBe('Home page');
    expect(await h.events('ticket.updated')).toEqual([]);
  });

  it('refuses an unknown ticket, a ticket of another project, an unknown or reviewing assignee and an unknown blocker', async () => {
    const { daemon, runToken } = await planning();
    const call = (input: object) => h.tool(daemon, runToken, 'ticket_update', input);
    expect(refusal(await call({ ticket: 'WEB-9', priority: 'low' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'No ticket WEB-9 in the project WEB: use ticket_list to find tickets.',
    });
    expect(refusal(await call({ ticket: 'APP-1', priority: 'low' })).code).toBe('NOT_FOUND');
    expect(refusal(await call({ ticket: 'WEB-1', assignee: 'nobody' }))).toMatchObject({
      code: 'NOT_FOUND',
      details: [{ field: 'assignee' }],
    });
    const reviewer = refusal(await call({ ticket: 'WEB-1', assignee: 'quality' }));
    expect(reviewer.code).toBe('VALIDATION_FAILED');
    expect(reviewer.message).toMatch(/^Quality reviews the work of other agents/);
    expect(refusal(await call({ ticket: 'WEB-1', blocked_by: ['WEB-7'] }))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'No ticket WEB-7 in the project WEB: blocked_by names tickets of the same project.',
    });
    // Nothing to change: refused by the input's schema.
    expect(refusal(await call({ ticket: 'WEB-1' })).code).toBe('VALIDATION_FAILED');
    expect(await h.events('ticket.updated')).toEqual([]);
  });

  it('refuses a ticket waiting for itself, and a cycle, naming it', async () => {
    const { daemon, runToken } = await planning();
    const itself = refusal(
      await h.tool(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', blocked_by: ['WEB-1'] }),
    );
    expect(itself).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'WEB-1 cannot wait for itself: remove it from blocked_by.',
    });
    await h.ok(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', blocked_by: ['WEB-2'] });
    const cycle = refusal(
      await h.tool(daemon, runToken, 'ticket_update', { ticket: 'WEB-2', blocked_by: ['WEB-1'] }),
    );
    expect(cycle).toMatchObject({
      code: 'VALIDATION_FAILED',
      message:
        'These dependencies would make WEB-2 wait for itself: WEB-2 → WEB-1 → WEB-2 (each waits for the next). Remove one of them from blocked_by.',
      details: [{ field: 'blocked_by', message: 'closes the cycle WEB-2 → WEB-1 → WEB-2' }],
    });
    // Replacing a ticket's own list never counts its old dependencies.
    await h.ok(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', blocked_by: [] });
    await h.ok(daemon, runToken, 'ticket_update', { ticket: 'WEB-2', blocked_by: ['WEB-1'] });
  });

  it("refuses texts above the owner's form limits, stating the setting's value", async () => {
    const { daemon, runToken } = await planning({ settings: { ticketTitleMaxLength: 12 } });
    const error = refusal(
      await h.tool(daemon, runToken, 'ticket_update', {
        ticket: 'WEB-1',
        title: 'A title that is too long',
      }),
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'title', setting: 'ticketTitleMaxLength' }],
    });
    expect(error.message).toContain(`(setting "${SETTINGS.ticketTitleMaxLength.label}": 12)`);
  });

  it('refuses every change once the project is archived', async () => {
    const { daemon, runToken } = await planning();
    await h.t.db.update(schema.projects).set({ status: 'archived' });
    expect(
      refusal(
        await h.tool(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', priority: 'low' }),
      ),
    ).toMatchObject({
      code: 'INVALID_TRANSITION',
      message: 'The project is archived: its tickets cannot be changed.',
    });
  });

  it('is refused to a builder in its ticket run, which does not list it', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runToken } = await h.running(daemon);
    const error = refusal(
      await h.tool(daemon, runToken, 'ticket_update', { ticket: 'WEB-1', priority: 'low' }),
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(
      await h.t.db
        .select({ priority: schema.tickets.priority })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.number, 1))),
    ).toEqual([{ priority: 'normal' }]);
  });
});
