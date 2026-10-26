import { schema } from '@orchestrator/db';
import {
  ApiError,
  EventPayloads,
  REQUEST_LINE_MAX_LENGTH,
  RequestDetail,
  RequestListResponse,
} from '@orchestrator/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// Requests (01, section 3.2; 02, section 5; lot 5 step D1): submitted, listed, shown and
// commented on by the owner; nothing starts yet.

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await startTestApp({ settings: { ticketDescriptionMaxLength: 200, commentMaxLength: 50 } });
  cookie = await createOwner(t.app);
  await seedProject('WEB', { name: 'Web shop' });
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
    kind: 'website',
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

function call(method: 'GET' | 'POST', url: string, payload?: object, headers = { cookie }) {
  return t.app.inject({ method, url: `/api/${url}`, headers, payload });
}

async function submit(body: string, project: string | null = null): Promise<RequestDetail> {
  const response = await call('POST', 'requests', { body, project });
  expect(response.statusCode, response.body).toBe(201);
  return RequestDetail.parse(response.json());
}

async function list(): Promise<RequestListResponse> {
  const response = await call('GET', 'requests');
  expect(response.statusCode, response.body).toBe(200);
  return RequestListResponse.parse(response.json());
}

async function events(type: 'request.created' | 'request.commented') {
  const rows = await t.db
    .select()
    .from(schema.events)
    .where(eq(schema.events.type, type))
    .orderBy(asc(schema.events.id));
  return rows.map((row) => ({
    entityType: row.entityType,
    projectId: row.projectId,
    actor: row.actor,
    payload: EventPayloads[type].parse(row.payload),
  }));
}

function refusal(response: { statusCode: number; json: () => unknown }) {
  return { status: response.statusCode, error: ApiError.parse(response.json()).error };
}

describe('submitting a request', () => {
  it('creates it open, numbered from 1 across projects, for a project or a new one', async () => {
    const first = await submit(
      '  A contact form on the home page\n\nName, e-mail and message.  ',
      'WEB',
    );
    expect(first).toMatchObject({
      number: 1,
      line: 'A contact form on the home page',
      status: 'open',
      project: { key: 'WEB', name: 'Web shop' },
      body: 'A contact form on the home page\n\nName, e-mail and message.',
      comments: [],
    });
    const second = await submit('A bakery website');
    expect(second).toMatchObject({ number: 2, status: 'open', project: null });

    // Nothing starts: no run, and the request stays open (step E2 plans it).
    expect(await t.db.select().from(schema.runs)).toEqual([]);
    expect((await list()).requests.map((each) => [each.number, each.status])).toEqual([
      [2, 'open'],
      [1, 'open'],
    ]);
  });

  it('writes request.created with its number, project and first line', async () => {
    await submit('\n  Add a newsletter sign-up\nwith double opt-in', 'WEB');
    await submit('A bakery website');
    const [project] = await t.db.select().from(schema.projects);
    expect(await events('request.created')).toEqual([
      {
        entityType: 'request',
        projectId: project?.id,
        actor: 'owner',
        payload: { request: 1, project: 'WEB', line: 'Add a newsletter sign-up' },
      },
      {
        entityType: 'request',
        projectId: null,
        actor: 'owner',
        payload: { request: 2, project: null, line: 'A bakery website' },
      },
    ]);
  });

  it('cuts a long first line for the screens, never the text', async () => {
    const long = 'word '.repeat(30).trim();
    const created = await submit(long);
    expect(created.line).toHaveLength(REQUEST_LINE_MAX_LENGTH);
    expect(created.line.endsWith('…')).toBe(true);
    expect(created.body).toBe(long);
  });

  it('accepts a project whose setup is not finished', async () => {
    await seedProject('NEW', { setupStatus: 'failed' });
    expect((await submit('Fix the setup later', 'NEW')).project?.key).toBe('NEW');
  });

  it('numbers requests submitted at the same time one after the other', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) => submit(`Request ${String(index)}`)),
    );
    expect(created.map((each) => each.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a text over Longest ticket description, naming the limit', async () => {
    const response = await call('POST', 'requests', { body: 'x'.repeat(201), project: null });
    expect(refusal(response)).toMatchObject({
      status: 400,
      error: {
        code: 'invalid_request',
        limits: [{ field: 'request', max: 200, unit: 'characters' }],
      },
    });
    expect((await submit('x'.repeat(200))).number).toBe(1);
  });

  it('refuses an empty text, an unknown field, an archived or unknown project', async () => {
    await seedProject('OLD', { status: 'archived' });
    expect((await call('POST', 'requests', { body: '   ', project: null })).statusCode).toBe(400);
    expect(
      (await call('POST', 'requests', { body: 'A', project: null, title: 'B' })).statusCode,
    ).toBe(400);
    expect(refusal(await call('POST', 'requests', { body: 'A', project: 'OLD' }))).toMatchObject({
      status: 409,
      error: { code: 'project_archived' },
    });
    expect(refusal(await call('POST', 'requests', { body: 'A', project: 'NOPE' }))).toMatchObject({
      status: 404,
      error: { code: 'project_not_found' },
    });
    // A refusal uses no number.
    expect((await submit('Accepted')).number).toBe(1);
    expect(await events('request.created')).toHaveLength(1);
  });

  it('needs a login', async () => {
    expect((await call('GET', 'requests', undefined, { cookie: '' })).statusCode).toBe(401);
    expect(
      (await call('POST', 'requests', { body: 'A', project: null }, { cookie: '' })).statusCode,
    ).toBe(401);
    expect((await call('GET', 'requests/1', undefined, { cookie: '' })).statusCode).toBe(401);
  });
});

describe('a request page', () => {
  it('gives the request by its number, and refuses an unknown one', async () => {
    await submit('A bakery website');
    const response = await call('GET', 'requests/1');
    expect(response.statusCode, response.body).toBe(200);
    expect(RequestDetail.parse(response.json())).toMatchObject({ number: 1, project: null });
    for (const number of ['2', '0', 'abc', '01']) {
      expect(refusal(await call('GET', `requests/${number}`))).toMatchObject({
        status: 404,
        error: { code: 'request_not_found' },
      });
    }
  });

  it('names the project as it is now', async () => {
    await submit('A contact form', 'WEB');
    await t.db
      .update(schema.projects)
      .set({ name: 'Bakery' })
      .where(eq(schema.projects.key, 'WEB'));
    expect((await list()).requests[0]?.project).toEqual({ key: 'WEB', name: 'Bakery' });
  });
});

describe("the owner's notes", () => {
  it('adds a note, oldest first, with request.commented', async () => {
    const created = await submit('A contact form', 'WEB');
    const first = await call('POST', 'requests/1/comments', { body: 'Only in French.' });
    expect(first.statusCode, first.body).toBe(201);
    const second = RequestDetail.parse(
      (await call('POST', 'requests/1/comments', { body: 'No e-mail.' })).json(),
    );
    expect(second.comments.map((each) => [each.author, each.kind, each.body])).toEqual([
      ['owner', 'note', 'Only in French.'],
      ['owner', 'note', 'No e-mail.'],
    ]);
    expect(second.updatedAt >= created.updatedAt).toBe(true);
    const [project] = await t.db.select().from(schema.projects);
    expect(await events('request.commented')).toEqual(
      second.comments.map((comment) => ({
        entityType: 'request',
        projectId: project?.id,
        actor: 'owner',
        payload: { request: 1, project: 'WEB', commentId: comment.id, kind: 'note' },
      })),
    );
  });

  it('refuses a note over Longest comment, an empty one and one on an unknown request', async () => {
    await submit('A bakery website');
    expect(
      refusal(await call('POST', 'requests/1/comments', { body: 'x'.repeat(51) })),
    ).toMatchObject({ status: 400, error: { limits: [{ field: 'comment', max: 50 }] } });
    expect((await call('POST', 'requests/1/comments', { body: ' ' })).statusCode).toBe(400);
    expect(refusal(await call('POST', 'requests/9/comments', { body: 'Hi' }))).toMatchObject({
      status: 404,
      error: { code: 'request_not_found' },
    });
    expect(await events('request.commented')).toEqual([]);
  });
});

describe('the database', () => {
  it('keeps each comment on a ticket or a request, never both or neither', async () => {
    const created = await submit('A bakery website');
    const [request] = await t.db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.number, created.number));
    const insert = (values: { ticketId?: string | null; requestId?: string | null }) =>
      t.db.execute(sql`INSERT INTO comments (ticket_id, request_id, author, kind, body)
        VALUES (${values.ticketId ?? null}, ${values.requestId ?? null}, 'owner', 'note', 'x')`);
    await expect(insert({})).rejects.toThrow();
    const [ticket] = await t.db
      .insert(schema.tickets)
      .values({
        projectId: (await t.db.select().from(schema.projects))[0]?.id ?? '',
        number: 1,
        type: 'feature',
        title: 'A',
        description: '',
        priority: 'normal',
        status: 'todo',
        createdBy: 'owner',
      })
      .returning();
    await expect(insert({ ticketId: ticket?.id, requestId: request?.id })).rejects.toThrow();
    await insert({ requestId: request?.id });
    await insert({ ticketId: ticket?.id });
  });
});
