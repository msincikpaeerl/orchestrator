import { schema } from '@orchestrator/db';
import {
  ApiError,
  TICKET_IMPORT_FORMAT,
  TicketDetail,
  TicketImportPreview,
  TicketImportResponse,
  type TicketImportProblem,
} from '@orchestrator/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// Import of a file of tickets (02, section 6.3; 06, section 4.6; lot 5bis step A).

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await startTestApp();
  cookie = await createOwner(t.app);
  await seedProject('WEB');
});

afterEach(async () => {
  await t.close();
});

type Project = typeof schema.projects.$inferInsert;

async function seedProject(key: string, overrides: Partial<Project> = {}) {
  await t.db.insert(schema.projects).values({
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
  });
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return t.app.inject({ method, url: `/api/${url}`, headers: { cookie }, payload });
}

/** A file in the format, its text as Claude would write it. */
function file(tickets: object[], extra: object = {}): string {
  return JSON.stringify({ format: TICKET_IMPORT_FORMAT, tickets, ...extra }, null, 2);
}

async function preview(text: string, key = 'WEB'): Promise<TicketImportPreview> {
  const response = await call('POST', `projects/${key}/tickets/import/preview`, { text });
  expect(response.statusCode, response.body).toBe(200);
  return TicketImportPreview.parse(response.json());
}

async function problems(text: string): Promise<TicketImportProblem[]> {
  return (await preview(text)).problems;
}

function importFile(text: string, key = 'WEB') {
  return call('POST', `projects/${key}/tickets/import`, { text });
}

async function createTicket(body: object = {}) {
  const response = await call('POST', 'projects/WEB/tickets', {
    type: 'feature',
    title: 'An existing ticket',
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return TicketDetail.parse(response.json());
}

async function ticket(number: number) {
  const response = await call('GET', `projects/WEB/tickets/${String(number)}`);
  expect(response.statusCode, response.body).toBe(200);
  return TicketDetail.parse(response.json());
}

/** What an import must leave untouched when it is refused. */
async function written() {
  const tickets = await t.db.select({ id: schema.tickets.id }).from(schema.tickets);
  const dependencies = await t.db.select().from(schema.ticketDependencies);
  const events = await t.db.select({ type: schema.events.type }).from(schema.events);
  const [project] = await t.db
    .select({ last: schema.projects.lastTicketNumber })
    .from(schema.projects)
    .where(eq(schema.projects.key, 'WEB'));
  return {
    tickets: tickets.length,
    dependencies: dependencies.length,
    events: events.length,
    last: project?.last,
  };
}

const contactFile = () =>
  file([
    {
      key: 'contact',
      type: 'feature',
      title: 'Contact form',
      description: 'A form that sends an email.',
      acceptance_criteria: ['Sends the message', 'Shows a confirmation'],
      priority: 'high',
      assignee: 'web_dev',
      // A key later in the file, and an existing ticket.
      blocked_by: ['layout', 'WEB-1'],
    },
    { key: 'layout', type: 'chore', title: 'Page layout', blocked_by: [] },
    {
      key: 'docs',
      type: 'docs',
      title: 'Help page',
      description: null,
      priority: null,
      assignee: null,
      blocked_by: ['contact'],
    },
  ]);

describe('a valid file', () => {
  it('previews the tickets with their dependencies, writing nothing', async () => {
    await createTicket();
    const before = await written();
    const result = await preview(contactFile());
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      'Assigned tickets can be started by the scheduler right away. Pause the account first if you do not want that.',
    ]);
    expect(result.tickets).toEqual([
      {
        position: 1,
        key: 'contact',
        type: 'feature',
        title: 'Contact form',
        priority: 'high',
        assignee: { key: 'web_dev', name: 'Web Developer' },
        criteria: 2,
        blockedBy: [
          { kind: 'file', key: 'layout', title: 'Page layout' },
          { kind: 'ticket', number: 1, title: 'An existing ticket', status: 'todo' },
        ],
      },
      {
        position: 2,
        key: 'layout',
        type: 'chore',
        title: 'Page layout',
        priority: 'normal',
        assignee: null,
        criteria: 0,
        blockedBy: [],
      },
      {
        position: 3,
        key: 'docs',
        type: 'docs',
        title: 'Help page',
        priority: 'normal',
        assignee: null,
        criteria: 0,
        blockedBy: [{ kind: 'file', key: 'contact', title: 'Contact form' }],
      },
    ]);
    expect(await written()).toEqual(before);
  });

  it('imports every ticket in todo, numbered in the file order, with their events', async () => {
    await createTicket();
    const response = await importFile(contactFile());
    expect(response.statusCode, response.body).toBe(201);
    expect(TicketImportResponse.parse(response.json()).tickets).toEqual([
      { number: 2, title: 'Contact form', status: 'todo' },
      { number: 3, title: 'Page layout', status: 'todo' },
      { number: 4, title: 'Help page', status: 'todo' },
    ]);

    const contact = await ticket(2);
    expect(contact).toMatchObject({
      type: 'feature',
      title: 'Contact form',
      description: 'A form that sends an email.',
      acceptanceCriteria: ['Sends the message', 'Shows a confirmation'],
      priority: 'high',
      status: 'todo',
      createdBy: 'owner',
      assignee: { key: 'web_dev', name: 'Web Developer' },
      blocked: true,
    });
    expect(contact.blockedBy.map((link) => link.number)).toEqual([1, 3]);
    expect((await ticket(4)).blockedBy.map((link) => link.number)).toEqual([2]);
    expect((await ticket(3)).blocks.map((link) => link.number)).toEqual([2]);

    const events = await t.db.select().from(schema.events).orderBy(asc(schema.events.id));
    const imported = events.filter((row) => /^tickets?\./.test(row.type));
    expect(imported.map((row) => [row.type, row.payload])).toEqual([
      ['ticket.created', expect.objectContaining({ ticket: 'WEB-1' })],
      [
        'ticket.created',
        expect.objectContaining({
          ticket: 'WEB-2',
          blockedBy: ['WEB-1', 'WEB-3'],
          assignee: 'web_dev',
          assigneeName: 'Web Developer',
          status: 'todo',
        }),
      ],
      ['ticket.created', expect.objectContaining({ ticket: 'WEB-3', blockedBy: [] })],
      ['ticket.created', expect.objectContaining({ ticket: 'WEB-4', blockedBy: ['WEB-2'] })],
      ['tickets.imported', { key: 'WEB', count: 3, tickets: ['WEB-2', 'WEB-3', 'WEB-4'] }],
    ]);
    const last = imported.at(-1);
    expect(last?.entityType).toBe('project');
    expect(last?.actor).toBe('owner');
  });

  it('warns about a cancelled blocker, not a done one, and still imports', async () => {
    await createTicket({ title: 'Old idea' });
    await createTicket({ title: 'Finished' });
    expect((await call('POST', 'projects/WEB/tickets/1/cancel')).statusCode).toBe(200);
    expect(
      (await call('POST', 'projects/WEB/tickets/2/mark-done', { comment: 'Done by hand' }))
        .statusCode,
    ).toBe(200);
    const text = file([
      { key: 'next', type: 'feature', title: 'Next step', blocked_by: ['WEB-1', 'WEB-2'] },
    ]);
    const result = await preview(text);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      'next is blocked by WEB-1, which is cancelled: it will stay blocked until you remove that dependency.',
    ]);
    expect((await importFile(text)).statusCode).toBe(201);
  });
});

describe('refusals, each located', () => {
  const one = (fields: object) => file([{ key: 'one', type: 'feature', title: 'One', ...fields }]);

  it('refuses a text that is not JSON, or empty, naming the place', async () => {
    expect(await problems('{\n  "format": "orchestrator-tickets/1",\n  "tickets": [}\n')).toEqual([
      {
        position: null,
        key: null,
        field: null,
        message:
          'The text is not valid JSON (line 3, column 15): check the commas, quotes and brackets around there.',
      },
    ]);
    expect(await problems('  ')).toEqual([
      {
        position: null,
        key: null,
        field: null,
        message: 'Paste the text of the file, or choose a .json file.',
      },
    ]);
  });

  it('refuses another format and a file without tickets', async () => {
    expect(await problems(JSON.stringify({ format: 'tickets/2', tickets: [] }))).toEqual([
      { position: null, key: null, field: 'format', message: `Must be "${TICKET_IMPORT_FORMAT}".` },
      { position: null, key: null, field: 'tickets', message: 'The file has no tickets.' },
    ]);
    expect(await problems(JSON.stringify({ tickets: [] }))).toContainEqual({
      position: null,
      key: null,
      field: 'format',
      message: 'This field is missing.',
    });
  });

  it('refuses an unknown field, in the file and in a ticket', async () => {
    expect(await problems(one({ bootstrap: true }))).toEqual([
      {
        position: 1,
        key: 'one',
        field: 'bootstrap',
        message:
          'Unknown field “bootstrap”: remove it or correct its spelling. The fields are key, type, title, description, acceptance_criteria, priority, assignee, blocked_by.',
      },
    ]);
    expect(await problems(file([{ key: 'a', type: 'bug', title: 'A' }], { summary: 'x' }))).toEqual(
      [
        {
          position: null,
          key: null,
          field: 'summary',
          message:
            'Unknown field “summary”: remove it or correct its spelling. The fields are format, tickets.',
        },
      ],
    );
  });

  it('refuses missing and malformed fields', async () => {
    expect(
      await problems(
        file([
          { key: 'Contact Form', type: 'story', title: '  ' },
          { type: 'bug', title: 3, acceptance_criteria: ['ok', ''] },
        ]),
      ),
    ).toEqual([
      {
        position: 1,
        key: 'Contact Form',
        field: 'key',
        message:
          'Must be 1 to 40 lowercase letters, digits, "-" or "_", starting with a letter or a digit, such as "contact-form".',
      },
      {
        position: 1,
        key: 'Contact Form',
        field: 'type',
        message: '“story” is not possible: use one of feature, bug, chore, docs, spike.',
      },
      { position: 1, key: 'Contact Form', field: 'title', message: 'Cannot be empty.' },
      { position: 2, key: null, field: 'key', message: 'This field is missing.' },
      {
        position: 2,
        key: null,
        field: 'title',
        message: 'Must be a text in quotes, not a number.',
      },
      {
        position: 2,
        key: null,
        field: 'acceptance_criteria',
        message: 'Criterion 2: cannot be empty.',
      },
    ]);
  });

  it('refuses a key used twice', async () => {
    expect(
      await problems(
        file([
          { key: 'a', type: 'bug', title: 'A' },
          { key: 'a', type: 'bug', title: 'B' },
        ]),
      ),
    ).toEqual([
      {
        position: 2,
        key: 'a',
        field: 'key',
        message:
          'The key “a” is already the key of ticket 1: each key must be used once in the file.',
      },
    ]);
  });

  it("refuses the owner's form limits, with the settings' current values", async () => {
    for (const [name, value] of [
      ['ticketTitleMaxLength', 5],
      ['ticketDescriptionMaxLength', 10],
      ['ticketMaxAcceptanceCriteria', 2],
      ['acceptanceCriterionMaxLength', 4],
    ] as const) {
      expect((await call('PUT', `settings/${name}`, { value })).statusCode).toBe(200);
    }
    expect(
      await problems(
        one({
          title: 'Too long',
          description: 'Eleven char',
          acceptance_criteria: ['fine', 'too long', 'ok'],
        }),
      ),
    ).toEqual([
      {
        position: 1,
        key: 'one',
        field: 'title',
        message: 'Too long: 8 characters, at most 5, the setting “Longest ticket title”.',
      },
      {
        position: 1,
        key: 'one',
        field: 'description',
        message: 'Too long: 11 characters, at most 10, the setting “Longest ticket description”.',
      },
      {
        position: 1,
        key: 'one',
        field: 'acceptance_criteria',
        message: '3 criteria: at most 2, the setting “Most acceptance criteria”.',
      },
      {
        position: 1,
        key: 'one',
        field: 'acceptance_criteria',
        message:
          'Criterion 2 is too long: 8 characters, at most 4, the setting “Longest acceptance criterion”.',
      },
    ]);
  });

  it('refuses an assignee that does not exist or cannot be assigned', async () => {
    const assignable =
      'The agents you can assign are architect (Architect), web_dev (Web Developer).';
    expect(
      await problems(
        file([
          { key: 'a', type: 'docs', title: 'A', assignee: 'writer' },
          { key: 'b', type: 'feature', title: 'B', assignee: 'quality' },
        ]),
      ),
    ).toEqual([
      {
        position: 1,
        key: 'a',
        field: 'assignee',
        message: `No agent profile with the key writer. ${assignable}`,
      },
      {
        position: 2,
        key: 'b',
        field: 'assignee',
        message: `Quality reviews the work of other agents and cannot be assigned a ticket. ${assignable}`,
      },
    ]);
  });

  it('refuses dependencies that name nothing of this file or project', async () => {
    await createTicket();
    expect(
      await problems(one({ blocked_by: ['one', 'missing', 'WEB-9', 'API-1', 'Setup!', 'WEB-1'] })),
    ).toEqual(
      [
        "“one” is this ticket's own key: a ticket cannot wait for itself.",
        'No ticket of the file has the key “missing”.',
        'There is no ticket WEB-9 in this project.',
        'API-1 belongs to another project: a ticket can only wait for tickets of WEB.',
        '“Setup!” is neither a key of this file nor a ticket number such as WEB-3.',
      ].map((message) => ({ position: 1, key: 'one', field: 'blocked_by', message })),
    );
  });

  it('refuses a cycle inside the file, naming it once', async () => {
    const text = file([
      { key: 'a', type: 'feature', title: 'A', blocked_by: ['c'] },
      { key: 'b', type: 'feature', title: 'B', blocked_by: ['a'] },
      { key: 'c', type: 'feature', title: 'C', blocked_by: ['b'] },
      { key: 'd', type: 'feature', title: 'D', blocked_by: ['d2'] },
      { key: 'd2', type: 'feature', title: 'D2', blocked_by: ['d'] },
    ]);
    expect(await problems(text)).toEqual([
      {
        position: 1,
        key: 'a',
        field: 'blocked_by',
        message:
          'These tickets wait for each other, so none of them could ever start: a → c → b → a. Remove one of these dependencies.',
      },
      {
        position: 4,
        key: 'd',
        field: 'blocked_by',
        message:
          'These tickets wait for each other, so none of them could ever start: d → d2 → d. Remove one of these dependencies.',
      },
    ]);
  });

  it("checks cycles over the project's tickets too: a chain through them is no cycle", async () => {
    // No ticket of the project can wait for a ticket of the file, which does not exist yet, so
    // a cycle cannot go through an existing ticket; the check still walks the project's graph.
    await createTicket({ title: 'First' });
    await createTicket({ title: 'Second', blockedBy: [1] });
    const text = file([
      { key: 'a', type: 'feature', title: 'A', blocked_by: ['WEB-2'] },
      { key: 'b', type: 'feature', title: 'B', blocked_by: ['a', 'WEB-1'] },
    ]);
    expect(await problems(text)).toEqual([]);
    expect((await importFile(text)).statusCode).toBe(201);
  });

  it('refuses more tickets than Most tickets per plan, stating its value', async () => {
    expect(
      (await call('PUT', 'projects/WEB/settings/maxTicketsPerPlan', { value: 2 })).statusCode,
    ).toBe(200);
    const text = file(
      ['a', 'b', 'c'].map((key) => ({ key, type: 'chore', title: key.toUpperCase() })),
    );
    expect(await problems(text)).toEqual([
      {
        position: null,
        key: null,
        field: 'tickets',
        message:
          'The file has 3 tickets: at most 2 can be imported at once, the setting “Most tickets per plan”. Split the file in two.',
      },
    ]);
    const refused = await importFile(text);
    expect(refused.statusCode).toBe(422);
    expect(ApiError.parse(refused.json()).error.importProblems).toHaveLength(1);
  });
});

describe('the import', () => {
  it('checks again and creates nothing when a problem appeared since the preview', async () => {
    const text = file([
      { key: 'a', type: 'feature', title: 'A' },
      { key: 'b', type: 'feature', title: 'B' },
    ]);
    expect(await problems(text)).toEqual([]);
    expect(
      (await call('PUT', 'projects/WEB/settings/maxTicketsPerPlan', { value: 1 })).statusCode,
    ).toBe(200);
    const before = await written();
    const refused = await importFile(text);
    expect(refused.statusCode).toBe(422);
    const { error } = ApiError.parse(refused.json());
    expect(error.code).toBe('ticket_import_invalid');
    expect(error.message).toBe('The file has 1 problem: nothing was imported');
    expect(error.importProblems?.[0]?.message).toContain('at most 1 can be imported');
    expect(await written()).toEqual(before);
  });

  it('refuses the whole file for one bad ticket among good ones', async () => {
    const before = await written();
    const refused = await importFile(
      file([
        { key: 'a', type: 'feature', title: 'A' },
        { key: 'b', type: 'feature', title: 'B', assignee: 'nobody' },
        { key: 'c', type: 'feature', title: 'C', blocked_by: ['a'] },
      ]),
    );
    expect(refused.statusCode).toBe(422);
    expect(ApiError.parse(refused.json()).error.importProblems).toEqual([
      expect.objectContaining({ position: 2, key: 'b', field: 'assignee' }),
    ]);
    expect(await written()).toEqual(before);
  });

  it('writes nothing when the database fails halfway', async () => {
    // A failure after the first tickets are inserted: the transaction leaves none behind.
    await t.db.execute(sql`
      create function refuse_explode() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$;
      create trigger refuse_explode before insert on tickets
        for each row when (new.title = 'Explode') execute function refuse_explode();
    `);
    const before = await written();
    const failed = await importFile(
      file([
        { key: 'a', type: 'feature', title: 'A' },
        { key: 'b', type: 'feature', title: 'B', blocked_by: ['a'] },
        { key: 'c', type: 'feature', title: 'Explode' },
      ]),
    );
    expect(failed.statusCode).toBe(500);
    expect(await written()).toEqual(before);
  });

  it('refuses an archived project and one whose setup is not ready', async () => {
    await seedProject('OLD', { status: 'archived' });
    await seedProject('NEW', { setupStatus: 'in_progress' });
    const text = file([{ key: 'a', type: 'feature', title: 'A' }]);
    for (const [key, code] of [
      ['OLD', 'project_archived'],
      ['NEW', 'project_not_ready'],
    ] as const) {
      for (const path of ['tickets/import/preview', 'tickets/import']) {
        const response = await call('POST', `projects/${key}/${path}`, { text });
        expect(response.statusCode).toBe(409);
        expect(ApiError.parse(response.json()).error.code).toBe(code);
      }
    }
    expect(await t.db.select().from(schema.tickets)).toEqual([]);
  });

  it('needs a session and a strict body', async () => {
    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/projects/WEB/tickets/import',
      payload: { text: '{}' },
    });
    expect(anonymous.statusCode).toBe(401);
    const extra = await call('POST', 'projects/WEB/tickets/import/preview', { text: '{}', x: 1 });
    expect(extra.statusCode).toBe(400);
  });
});
