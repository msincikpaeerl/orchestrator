import { createPool, endPool, runMigrations, schema } from '@orchestrator/db';
import { createTestDatabase, migrateUpTo } from '@orchestrator/db/testing';
import {
  ApiError,
  EVENT_LOG_PAGE_SIZE,
  EVENT_QUOTE_MAX_LENGTH,
  EventListResponse,
  EventType,
  ProjectListResponse,
  type EventLogEntry,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../src/events.js';
import { startEveryEventApp, writeEveryEvent } from './every-event.js';
import { startFakeGitHub, type FakeGitHub } from './fake-github.js';
import { createOwner, OWNER, sessionCookie, startTestApp, type TestApp } from './helpers.js';

let github: FakeGitHub;
let everyEvent: Promise<TestApp> | undefined;

// Writing every event type goes through most of the product, and grows with each new event
// type: about 1 second on an idle machine, 6.5 to 8.7 seconds while two full test suites run
// beside it (lot 3 step J0). It is done once for the file, under its own longer deadline.
const EVERY_EVENT_TIMEOUT_MS = 30_000;

/** The app holding every event type, written once for the whole file. */
function appWithEveryEvent(): Promise<TestApp> {
  everyEvent ??= (async () => {
    github.accounts.clear();
    const t = await startEveryEventApp(github);
    await writeEveryEvent(t, github);
    return t;
  })();
  return everyEvent;
}

beforeAll(async () => {
  github = await startFakeGitHub();
});

afterAll(async () => {
  await (await everyEvent)?.close();
  await github.close();
});

async function login(t: TestApp): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER.username, password: 'another correct horse battery' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return sessionCookie(response.headers['set-cookie']);
}

/** Every page of the log for `query`, newest first. */
async function readAll(t: TestApp, cookie: string, query = ''): Promise<EventLogEntry[]> {
  const all: EventLogEntry[] = [];
  let before: string | null = null;
  do {
    const cursor: string = before === null ? '' : `before=${encodeURIComponent(before)}`;
    const separator = query && cursor ? '&' : '';
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/events?${query}${separator}${cursor}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = EventListResponse.parse(response.json());
    all.push(...page.events);
    before = page.next;
  } while (before !== null);
  return all;
}

describe('events of every type', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await appWithEveryEvent();
    cookie = await login(t);
  }, EVERY_EVENT_TIMEOUT_MS);

  it('writes every event type, each with the payload its plain-words text needs', async () => {
    const events = await readAll(t, cookie);
    const types = new Set(events.map((event) => event.type));
    expect([...types].sort()).toEqual([...EventType.options].sort());
    for (const event of events) {
      expect(event.payload, `${event.type} ${String(event.id)}`).not.toBeNull();
    }
  });

  it('gives each event the project it concerns, and none to the others', async () => {
    const events = await readAll(t, cookie);
    const byType = (type: string) => events.filter((event) => event.type === type);
    for (const event of events) {
      const concernsProject =
        event.entityType === 'project' ||
        event.entityType === 'ticket' ||
        event.entityType === 'run' ||
        (event.entityType === 'setting' && event.payload?.scope === 'project');
      expect(event.project !== null, `${event.type} ${String(event.id)}`).toBe(concernsProject);
      if (event.entityType === 'ticket') expect(event.ticket).not.toBeNull();
    }
    expect(byType('project.harness_checked').map((event) => event.project)).toEqual([
      { key: 'LEG' },
    ]);
    expect(byType('ticket.dependency_added')[0]).toMatchObject({
      project: { key: 'SHOP' },
      ticket: { number: 2 },
    });
    expect(byType('setting.changed').map((event) => event.project)).toEqual([
      { key: 'SHOP' },
      null,
    ]);
  });

  it('quotes the comment of a comment and of a Mark as done manually', async () => {
    const events = await readAll(t, cookie, 'project=SHOP&ticket=1');
    expect(events.find((event) => event.type === 'ticket.commented')?.comment).toBe('Looks *good*');
    expect(events.find((event) => event.type === 'ticket.status_changed')?.comment).toBe(
      'Done by hand',
    );
  });

  it('filters by project, ticket, kind of entity, event type and date', async () => {
    const all = await readAll(t, cookie);
    const leg = await readAll(t, cookie, 'project=LEG');
    expect(leg.length).toBeGreaterThan(0);
    expect(leg.every((event) => event.project?.key === 'LEG')).toBe(true);
    expect(leg).toEqual(all.filter((event) => event.project?.key === 'LEG'));

    const ticket = await readAll(t, cookie, 'project=SHOP&ticket=2');
    expect(ticket.map((event) => event.type).reverse()).toEqual([
      'ticket.created',
      'ticket.updated',
      'ticket.dependency_added',
      'ticket.dependency_removed',
      // Run now, the agent's refused then accepted submission, its pull request, then the run's
      // end (a Claude Code too old at its start).
      'ticket.status_changed',
      'ticket.submission_refused',
      'ticket.submitted',
      // Its pull request: not opened, reopened by Try again, updated, then opened after a merge.
      'ticket.pull_request_not_opened',
      'ticket.pull_request_reopened',
      'ticket.pull_request_updated',
      'ticket.pull_request_opened',
      'ticket.status_changed',
      // Check CI again on the ended run, refused (lot 3 step G2c).
      'ticket.ci_checked_again',
    ]);

    const settings = await readAll(t, cookie, 'entity=setting');
    expect(settings.map((event) => event.type).reverse()).toEqual([
      'setting.changed',
      'setting.reset',
      'setting.changed',
      'setting.reset',
    ]);
    expect(await readAll(t, cookie, 'entity=setting&project=SHOP')).toHaveLength(2);

    const ready = await readAll(t, cookie, 'type=project.ready');
    expect(ready.map((event) => event.project?.key).sort()).toEqual(['LEG', 'SHOP']);

    // Dates: from included, to excluded.
    const middle = all[Math.floor(all.length / 2)];
    if (!middle) throw new Error('no events');
    const from = await readAll(t, cookie, `from=${middle.at}`);
    expect(from).toEqual(all.filter((event) => event.at >= middle.at));
    const to = await readAll(t, cookie, `to=${middle.at}`);
    expect(to).toEqual(all.filter((event) => event.at < middle.at));
    expect(await readAll(t, cookie, 'from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z')).toEqual(
      [],
    );
  });

  it('refuses an unknown project or ticket, and a ticket without its project', async () => {
    const get = (query: string) =>
      t.app.inject({ method: 'GET', url: `/api/events?${query}`, headers: { cookie } });
    const code = async (query: string) => ApiError.parse((await get(query)).json()).error.code;
    expect(await code('project=NOPE')).toBe('project_not_found');
    expect(await code('project=SHOP&ticket=99')).toBe('ticket_not_found');
    expect(await code('ticket=1')).toBe('invalid_request');
    expect(await code('type=owner.unknown')).toBe('invalid_request');
    expect(await code('before=yesterday')).toBe('invalid_request');
  });

  it('shows each project with the time of its latest event as last activity', async () => {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/projects?archived=true',
      headers: { cookie },
    });
    const { projects } = ProjectListResponse.parse(response.json());
    for (const project of projects) {
      const [latest] = await readAll(t, cookie, `project=${project.key}`);
      expect(project.lastActivity).toBe(latest?.at);
    }
  });
});

describe('migration of the events written before the project reference', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await appWithEveryEvent();
  }, EVERY_EVENT_TIMEOUT_MS);

  it('gives them the same project as the current code does', async () => {
    const old = await createTestDatabase({ empty: true });
    const oldPool = createPool({ connectionString: old.url });
    try {
      await migrateUpTo(oldPool, '0005_settings');

      // The same rows in a database of lot 1 before this step: events without project_id.
      for (const table of ['projects', 'tickets']) {
        const { rows } = await t.pool.query<{ rows: unknown }>(
          `SELECT json_agg(r) AS rows FROM ${table} r`,
        );
        await oldPool.query(
          `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1)`,
          [JSON.stringify(rows[0]?.rows)],
        );
      }
      // Runs came after this migration (lot 2): a database of lot 1 never held their events.
      const { rows } = await t.pool.query<{ rows: unknown }>(
        `SELECT json_agg(e) AS rows FROM events e WHERE e.entity_type <> 'run'`,
      );
      await oldPool.query(
        `INSERT INTO events (id, created_at, actor, entity_type, entity_id, type, payload)
         OVERRIDING SYSTEM VALUE
         SELECT id, created_at, actor, entity_type, entity_id, type, payload
         FROM json_populate_recordset(null::events, $1)`,
        [JSON.stringify(rows[0]?.rows)],
      );

      await runMigrations(oldPool);

      const expected = await t.pool.query<{ id: string; project_id: string | null }>(
        "SELECT id, project_id FROM events WHERE entity_type <> 'run' ORDER BY id",
      );
      const migrated = await oldPool.query<{ id: string; project_id: string | null }>(
        'SELECT id, project_id FROM events ORDER BY id',
      );
      expect(migrated.rows).toEqual(expected.rows);
      expect(expected.rows.some((row) => row.project_id !== null)).toBe(true);
      expect(expected.rows.some((row) => row.project_id === null)).toBe(true);
    } finally {
      await endPool(oldPool);
      await old.drop();
    }
  });

  it('leaves an event whose entity id is not a known id without a project', async () => {
    const old = await createTestDatabase({ empty: true });
    const pool = createPool({ connectionString: old.url });
    try {
      await migrateUpTo(pool, '0005_settings');
      await pool.query(
        `INSERT INTO events (actor, entity_type, entity_id, type) VALUES
           ('owner', 'project', 'not-a-uuid', 'project.ready'),
           ('owner', 'ticket', '3f1e0e8c-0000-4000-8000-000000000000', 'ticket.created'),
           ('owner', 'setting', 'ciWaitTimeoutMinutes', 'setting.changed')`,
      );
      await runMigrations(pool);
      const { rows } = await pool.query('SELECT project_id FROM events');
      expect(rows).toEqual([{ project_id: null }, { project_id: null }, { project_id: null }]);
    } finally {
      await endPool(pool);
      await old.drop();
    }
  });
});

describe('event log', () => {
  let t: TestApp;
  let cookie: string;

  beforeEach(async () => {
    t = await startTestApp();
    cookie = await createOwner(t.app);
  });

  afterEach(async () => {
    await t.close();
  });

  function list(query = '') {
    return t.app.inject({ method: 'GET', url: `/api/events?${query}`, headers: { cookie } });
  }

  async function page(before: string | null) {
    const response = await list(before === null ? '' : `before=${encodeURIComponent(before)}`);
    expect(response.statusCode, response.body).toBe(200);
    return EventListResponse.parse(response.json());
  }

  function write(count: number, at?: Date) {
    return t.db.transaction(async (tx) => {
      for (let i = 0; i < count; i++) {
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'session',
          type: 'session.revoked',
          payload: { reason: 'logout' },
          at,
        });
      }
    });
  }

  it('needs a session', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/events' });
    expect(response.statusCode).toBe(401);
  });

  it('pages with a cursor: events written between two pages shift nothing', async () => {
    // Many events at the very same time, split by a page end: the id decides between them.
    await write(EVENT_LOG_PAGE_SIZE + 10, new Date('2020-01-01T10:00:00.000Z'));
    await write(EVENT_LOG_PAGE_SIZE);
    const before = (await t.db.select({ id: schema.events.id }).from(schema.events)).map(
      (row) => row.id,
    );

    const seen: number[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const result = await page(next);
      expect(result.events.length).toBeLessThanOrEqual(EVENT_LOG_PAGE_SIZE);
      seen.push(...result.events.map((event) => event.id));
      next = result.next;
      pages++;
      // New events arrive between two pages.
      await write(3);
    } while (next !== null);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => a - b)).toEqual([...before].sort((a, b) => a - b));
  });

  it('shows no secret, even when a payload or a comment holds one', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const pat = 'github_pat_11AAAAAAA0secretTokenValue1234567890';
    await recordEvent(t.db, {
      actor: 'owner',
      entityType: 'owner',
      type: 'owner.created',
      payload: { username: `me ${token}`, token, password: 'hunter2hunter2', nested: { pat } },
    });
    const [project] = await t.db
      .insert(schema.projects)
      .values({
        key: 'WEB',
        name: 'Web',
        slug: 'web',
        description: '',
        kind: 'web_app',
        repoOwner: 'o',
        repoName: 'web',
        repoOrigin: 'created',
        repoPrivate: true,
        setupStatus: 'ready',
      })
      .returning();
    if (!project) throw new Error('no project');
    const [ticket] = await t.db
      .insert(schema.tickets)
      .values({
        projectId: project.id,
        number: 1,
        type: 'bug',
        title: 'T',
        description: '',
        priority: 'normal',
        status: 'todo',
        createdBy: 'owner',
      })
      .returning();
    if (!ticket) throw new Error('no ticket');
    const [comment] = await t.db
      .insert(schema.comments)
      .values({ ticketId: ticket.id, author: 'owner', kind: 'note', body: `My token is ${pat}` })
      .returning();
    await recordEvent(t.db, {
      actor: 'owner',
      entityType: 'ticket',
      entityId: ticket.id,
      projectId: project.id,
      type: 'ticket.commented',
      payload: { project: 'WEB', ticket: 'WEB-1', commentId: comment?.id, kind: 'note' },
    });

    const response = await list();
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(pat);
    expect(response.body).not.toContain('hunter2');
    const { events } = EventListResponse.parse(response.json());
    expect(events.find((event) => event.type === 'owner.created')?.payload).toEqual({
      username: 'me [hidden]',
    });
    expect(events.find((event) => event.type === 'ticket.commented')?.comment).toBe(
      'My token is [hidden]',
    );
  });

  it('shortens a long comment to one line, and shows no payload that does not match its type', async () => {
    const [project] = await t.db
      .insert(schema.projects)
      .values({
        key: 'WEB',
        name: 'Web',
        slug: 'web',
        description: '',
        kind: 'web_app',
        repoOwner: 'o',
        repoName: 'web',
        repoOrigin: 'created',
        repoPrivate: true,
        setupStatus: 'ready',
      })
      .returning();
    if (!project) throw new Error('no project');
    const [ticket] = await t.db
      .insert(schema.tickets)
      .values({
        projectId: project.id,
        number: 1,
        type: 'bug',
        title: 'T',
        description: '',
        priority: 'normal',
        status: 'todo',
        createdBy: 'owner',
      })
      .returning();
    if (!ticket) throw new Error('no ticket');
    const [comment] = await t.db
      .insert(schema.comments)
      .values({
        ticketId: ticket.id,
        author: 'owner',
        kind: 'note',
        body: `# Title\n\n${'word '.repeat(2000)}`,
      })
      .returning();
    await recordEvent(t.db, {
      actor: 'owner',
      entityType: 'ticket',
      entityId: ticket.id,
      projectId: project.id,
      type: 'ticket.commented',
      payload: { project: 'WEB', ticket: 'WEB-1', commentId: comment?.id, kind: 'note' },
    });
    await recordEvent(t.db, { actor: 'system', entityType: 'project', type: 'project.ready' });

    const { events } = EventListResponse.parse((await list()).json());
    const quoted = events.find((event) => event.type === 'ticket.commented')?.comment ?? '';
    expect(Array.from(quoted)).toHaveLength(EVENT_QUOTE_MAX_LENGTH);
    expect(quoted).toMatch(/^# Title word word .*…$/);
    expect(events.find((event) => event.type === 'project.ready')?.payload).toBeNull();
    const [row] = await t.db
      .select({ projectId: schema.events.projectId })
      .from(schema.events)
      .where(eq(schema.events.type, 'ticket.commented'));
    expect(row?.projectId).toBe(project.id);
  });
});
