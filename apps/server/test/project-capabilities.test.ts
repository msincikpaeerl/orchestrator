import { schema } from '@orchestrator/db';
import {
  ApiError,
  Machine,
  Project,
  QueueResponse,
  Run,
  type DodReport,
} from '@orchestrator/protocol';
import { asc, eq, like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGED_FILES, RunHarness, cleanWorkspace, eventually } from './run-harness.js';

// What projects require (01, section 3.1; 02, section 6.5; 07, section 4; lot 5 step C2): the
// default for a new website or web app, a new repository or a linked one; the owner's edit and its
// event; a run needing the project's capabilities and its profile's, in the queue, Run now and
// Start review alike. Scripted daemons only: the daemon's side is step C1's.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

async function project(key: string): Promise<Project> {
  const response = await h.call('GET', `/api/projects/${key}`);
  expect(response.statusCode, response.body).toBe(200);
  return Project.parse(response.json());
}

/** Creates a project and waits for its background setup to finish. */
async function create(body: object): Promise<Project> {
  const response = await h.call('POST', '/api/projects', body);
  expect(response.statusCode, response.body).toBe(201);
  const { key } = Project.parse(response.json());
  let current = await project(key);
  await eventually(`the setup of ${key}`, async () => {
    current = await project(key);
    expect(current.setup.status).not.toBe('in_progress');
  });
  return current;
}

function requireCapabilities(key: string, capabilities: string[]) {
  return h.call('PUT', `/api/projects/${key}/required-capabilities`, { capabilities });
}

async function events(type: string) {
  return h.t.db
    .select()
    .from(schema.events)
    .where(like(schema.events.type, type))
    .orderBy(asc(schema.events.id));
}

async function addCapability(machineId: string, tag: string) {
  const response = await h.call('PUT', `/api/machines/${machineId}/capabilities`, {
    capabilities: ['git', 'node', tag],
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(Machine.parse(response.json()).capabilities).toContain(tag);
}

function missing(machine: { id: string; name: string }, capabilities: string[]) {
  return {
    reason: 'no_machine',
    machines: [{ machine, unavailable: { why: 'missing_capabilities', capabilities } }],
  };
}

describe('a new project (01, section 3.1)', () => {
  it('requires browser-tests for a website or a web app, a new repository or a linked one, and nothing for an Android app', async () => {
    await h.start();
    const site = await create({
      name: 'Shop',
      key: 'SHOP',
      kind: 'website',
      repository: { origin: 'created', name: 'shop', private: true },
    });
    expect(site.requiredCapabilities).toEqual(['browser-tests']);
    const linked = await create({
      name: 'Notes',
      key: 'NOTES',
      kind: 'web_app',
      repository: { origin: 'linked', name: 'notes' },
    });
    expect(linked.repository.origin).toBe('linked');
    expect(linked.requiredCapabilities).toEqual(['browser-tests']);
    const android = await create({
      name: 'Phone app',
      key: 'APP',
      kind: 'android_app',
      repository: { origin: 'created', name: 'phone-app', private: true },
    });
    expect(android.requiredCapabilities).toEqual([]);

    // The creation's event says it.
    const created = await events('project.created');
    expect(created.map((event) => event.payload)).toEqual([
      expect.objectContaining({ key: 'SHOP', requiredCapabilities: ['browser-tests'] }),
      expect.objectContaining({ key: 'NOTES', requiredCapabilities: ['browser-tests'] }),
      expect.objectContaining({ key: 'APP', requiredCapabilities: [] }),
    ]);
  });

  it('leaves a project created before unchanged: it requires nothing', async () => {
    // The harness's WEB website is written as the migration leaves an existing project.
    await h.start();
    expect((await project('WEB')).requiredCapabilities).toEqual([]);
  });
});

describe('Required capabilities in Project settings (02, section 6.5)', () => {
  it('saves the whole list with one event per change, and refuses a wrong list or an archived project', async () => {
    await h.start();
    const added = await requireCapabilities('WEB', ['browser-tests', 'android-sdk']);
    expect(added.statusCode, added.body).toBe(200);
    expect(Project.parse(added.json()).requiredCapabilities).toEqual([
      'browser-tests',
      'android-sdk',
    ]);
    // The same list again changes nothing.
    expect((await requireCapabilities('WEB', ['browser-tests', 'android-sdk'])).statusCode).toBe(
      200,
    );
    const removed = await requireCapabilities('WEB', ['android-sdk']);
    expect(Project.parse(removed.json()).requiredCapabilities).toEqual(['android-sdk']);
    expect(
      (await events('project.required_capabilities_changed')).map((event) => event.payload),
    ).toEqual([
      { key: 'WEB', previous: [], capabilities: ['browser-tests', 'android-sdk'] },
      { key: 'WEB', previous: ['browser-tests', 'android-sdk'], capabilities: ['android-sdk'] },
    ]);

    for (const capabilities of [['Browser Tests'], ['node', 'node']]) {
      const refused = await requireCapabilities('WEB', capabilities);
      expect(refused.statusCode, refused.body).toBe(400);
    }
    expect(
      (await h.call('PUT', '/api/projects/NONE/required-capabilities', { capabilities: [] }))
        .statusCode,
    ).toBe(404);

    expect((await h.call('POST', '/api/projects/WEB/archive')).statusCode).toBe(200);
    const archived = await requireCapabilities('WEB', []);
    expect(archived.statusCode).toBe(409);
    expect(ApiError.parse(archived.json()).error.code).toBe('project_archived');
    expect((await project('WEB')).requiredCapabilities).toEqual(['android-sdk']);
    expect(await events('project.required_capabilities_changed')).toHaveLength(2);
  });
});

describe("a run needs the project's capabilities and its profile's (07, section 4)", () => {
  it("names the missing one in the queue and in Run now's refusal, and starts once the machine has it", async () => {
    await h.start();
    await h.createTicket();
    const laptop = await h.machine();
    const ref = { id: laptop.id, name: 'Laptop' };
    expect((await requireCapabilities('WEB', ['browser-tests'])).statusCode).toBe(200);

    const queue = QueueResponse.parse((await h.call('GET', '/api/queue')).json());
    expect(queue.candidates.map((candidate) => candidate.reason)).toEqual([
      missing(ref, ['browser-tests']),
    ]);
    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toEqual(
      missing(ref, ['browser-tests']),
    );

    // The profile's own capability comes after the project's.
    await h.t.db
      .update(schema.agentProfiles)
      .set({ requiredCapabilities: ['android-sdk', 'browser-tests'] })
      .where(eq(schema.agentProfiles.key, 'web_dev'));
    const both = QueueResponse.parse((await h.call('GET', '/api/queue')).json());
    expect(both.candidates[0]?.reason).toEqual(missing(ref, ['browser-tests', 'android-sdk']));
    await h.t.db
      .update(schema.agentProfiles)
      .set({ requiredCapabilities: [] })
      .where(eq(schema.agentProfiles.key, 'web_dev'));

    await addCapability(laptop.id, 'browser-tests');
    const ready = QueueResponse.parse((await h.call('GET', '/api/queue')).json());
    expect(ready.candidates[0]).toMatchObject({ reason: null, machine: ref });
    const { runId } = await h.running(laptop.daemon);
    expect((await h.run(runId)).status).toBe('running');
  });

  it("refuses Start review on a machine without the project's capability", async () => {
    await h.start();
    await h.createTicket();
    const laptop = await h.machine();
    const { runId, runToken } = await h.running(laptop.daemon);
    const report: DodReport = {
      criteria: [
        { number: 1, status: 'met', justification: 'ContactForm renders the form' },
        { number: 2, status: 'met', justification: 'Tested in contact.test.ts' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: ['docs/user/contact.md'], justification: null },
      adrs: [],
      summary: 'Adds the contact form.',
    };
    const answer = await h.tool(
      laptop.daemon,
      runToken,
      'ticket_submit',
      report,
      cleanWorkspace({ changedFiles: { listed: CHANGED_FILES, count: CHANGED_FILES.length } }),
    );
    expect(answer.ok).toBe(true);
    await h.ciPasses(laptop.daemon, runId);
    await eventually('the ticket in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });

    // Required after the work was done: the review needs it too.
    expect((await requireCapabilities('WEB', ['browser-tests'])).statusCode).toBe(200);
    const ref = { id: laptop.id, name: 'Laptop' };
    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toEqual(
      missing(ref, ['browser-tests']),
    );
    const queue = QueueResponse.parse((await h.call('GET', '/api/queue')).json());
    expect(queue.candidates).toEqual([
      expect.objectContaining({ kind: 'review', reason: missing(ref, ['browser-tests']) }),
    ]);

    await addCapability(laptop.id, 'browser-tests');
    const started = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(started.statusCode, started.body).toBe(201);
    expect(Run.parse(started.json()).purpose).toBe('review');
  });
});
