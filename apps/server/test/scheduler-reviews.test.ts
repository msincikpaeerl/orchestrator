import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  Project,
  QueueResponse,
  Run,
  TicketDetail,
  type DodReport,
  type NeedsYouItem,
  type QueueCandidate,
  type RunStart,
} from '@orchestrator/protocol';
import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, cleanWorkspace, eventually, state } from './run-harness.js';

// Reviews and fixes by themselves (07, section 1; 04, section 2; lot 4 step D3), with the real
// application, a scripted daemon and the fake GitHub: the scheduler starts a ticket's review once
// it is ready, and its fix after a request for changes, Quality's or the owner's; the project's
// switch **Start reviews by themselves** keeps reviews for **Start review**; what bounds them.
// The tests run the loop's ticks themselves (`schedulerTick()`).

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

const REPORT: DodReport = {
  criteria: [
    { number: 1, status: 'met', justification: 'ContactForm renders the form' },
    { number: 2, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};
const POINTS = [{ body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts' }];

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  expect(result.locked).toBe(true);
  return result.started.map((start) => `${start.kind} ${start.ticket}`);
}

async function queue(): Promise<QueueCandidate[]> {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  return QueueResponse.parse(response.json()).candidates;
}

async function readyItems(): Promise<Extract<NeedsYouItem, { type: 'ready_for_review' }>[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items.filter(
    (item) => item.type === 'ready_for_review',
  );
}

async function latestRun(number = 1) {
  const ticket = await h.ticket(number);
  const [last] = await h.t.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.ticketId, ticket.id))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!last) throw new Error(`WEB-${String(number)} has no run`);
  return last;
}

function starts(daemon: ScriptedDaemon): RunStart[] {
  return daemon.received.filter((message): message is RunStart => message.type === 'run.start');
}

/** The run the loop just started, working, submits and passes CI: the ticket in review. */
async function builds(daemon: ScriptedDaemon, number = 1) {
  const run = await latestRun(number);
  const { runToken } = await h.working(daemon, run.id, number);
  const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT, cleanWorkspace());
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  await h.ciPasses(daemon, run.id);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket(number)).status).toBe('in_review');
  });
  return run;
}

/** The review run the loop just started decides, and its decision is applied at its end. */
async function decides(daemon: ScriptedDaemon, decision: 'approve' | 'changes') {
  const run = await latestRun();
  expect(run.purpose).toBe('review');
  const { runToken } = await h.working(daemon, run.id);
  if (decision === 'approve') {
    await h.ok(daemon, runToken, 'review_approve', { summary: 'Looks right.' });
  } else {
    await h.ok(daemon, runToken, 'review_request_changes', { points: POINTS });
  }
  await h.report(daemon, state(run.id, { state: 'ended', reason: 'submitted' }));
  return run;
}

/** The run the loop just started ends by itself on its idle timeout: a counted failure. */
async function failsCounted(daemon: ScriptedDaemon) {
  const run = await latestRun();
  await h.working(daemon, run.id);
  await h.report(daemon, state(run.id, { state: 'ended', reason: 'idle_timeout' }));
  await eventually('the run failed', async () => {
    expect((await h.run(run.id)).status).toBe('failed');
  });
  return run;
}

const reviewsAutomatic = (on: boolean) =>
  h.call('PUT', '/api/projects/WEB/reviews-automatic', { on });

/** Every run of WEB-1 the owner started: none in the cases "with no owner action". */
async function ownerStarts(): Promise<number> {
  return (await h.events('run.created')).filter((event) => event.actor === 'owner').length;
}

describe('reviews and fixes by themselves (07, section 1)', () => {
  it('implement, review, changes requested, fix, review, approved: Awaiting merge with no owner action', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    // A project is created with the switch on.
    expect(Project.parse((await h.call('GET', '/api/projects/WEB')).json()).reviewsAutomatic).toBe(
      true,
    );

    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    // "Ready for review" and the ticket page say the review starts by itself.
    expect(await readyItems()).toMatchObject([{ start: 'by_itself' }]);
    expect((await h.ticket()).review).toMatchObject({ offered: true, start: 'by_itself' });

    expect(await tick()).toEqual(['review WEB-1']);
    await decides(daemon, 'changes');
    expect(await h.ticket()).toMatchObject({ status: 'todo', reviewRounds: 1 });

    // Quality's request: the fix starts by itself.
    expect(await tick()).toEqual(['fix_review WEB-1']);
    expect((await latestRun()).purpose).toBe('fix_review');
    await builds(daemon);

    expect(await tick()).toEqual(['review WEB-1']);
    await decides(daemon, 'approve');
    expect((await h.ticket()).status).toBe('awaiting_merge');
    expect(await tick()).toEqual([]);

    expect(starts(daemon)).toHaveLength(4);
    expect(await ownerStarts()).toBe(0);
  });

  it("fixes after Quality's requests stop at Most review rounds per ticket", async () => {
    await h.start({ settings: { maxReviewRounds: 1 } });
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    expect(await tick()).toEqual(['review WEB-1']);
    await decides(daemon, 'changes');
    expect(await tick()).toEqual(['fix_review WEB-1']);
    await builds(daemon);
    expect(await tick()).toEqual(['review WEB-1']);
    await decides(daemon, 'changes');

    // Round 2, one more than the setting allows: stopped, and nothing starts by itself.
    expect(await h.ticket()).toMatchObject({
      status: 'todo',
      reviewRounds: 2,
      stop: { cause: 'review_rounds', count: 2, limit: 1 },
    });
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    const [candidate] = await queue();
    expect(candidate).toMatchObject({
      kind: 'fix_review',
      reason: { reason: 'ticket_stopped', cause: 'review_rounds' },
    });
    expect(starts(daemon)).toHaveLength(4);
    expect(await ownerStarts()).toBe(0);
  });

  it("a fix after the owner's Request changes starts by itself, and stops at Failed attempts before asking you", async () => {
    await h.start({ settings: { maxFailedAttempts: 2 } });
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);

    // The owner asks for changes before the review (box unchecked): the fix comes first.
    const requested = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Also add a link to the map.',
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect((await h.ticket()).held).toBeNull();
    const [fix] = await queue();
    expect(fix).toMatchObject({ kind: 'fix_review', reason: null });

    // It fails twice, each time started again by itself, then the ticket stops.
    expect(await tick()).toEqual(['fix_review WEB-1']);
    await failsCounted(daemon);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1, stop: null });
    expect(await tick()).toEqual(['fix_review WEB-1']);
    const second = await failsCounted(daemon);
    expect(second.purpose).toBe('fix_review');
    expect(await h.ticket()).toMatchObject({
      attemptCount: 2,
      stop: { cause: 'failed_attempts', count: 2, limit: 2 },
    });
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(starts(daemon)).toHaveLength(3);
  });

  it('Skip review before the review starts: nothing to start', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    expect(await queue()).toMatchObject([{ kind: 'review', reason: null }]);

    const skipped = await h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect((await h.ticket()).status).toBe('awaiting_merge');
    expect(await queue()).toEqual([]);
    expect(await tick()).toEqual([]);
    expect(starts(daemon)).toHaveLength(1);
  });
});

describe('the switch Start reviews by themselves (02, section 6.5)', () => {
  it('off: the review waits for Start review, the queue and the screens say so; on again: it starts', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    // The review is next in the queue when the owner turns the switch off.
    expect(await queue()).toMatchObject([{ kind: 'review', reason: null }]);

    const off = await reviewsAutomatic(false);
    expect(off.statusCode, off.body).toBe(200);
    expect(Project.parse(off.json()).reviewsAutomatic).toBe(false);
    expect(await h.events('project.reviews_automatic_changed')).toMatchObject([
      { actor: 'owner', payload: { key: 'WEB', on: false } },
    ]);
    // The same value again changes nothing and writes no event.
    expect((await reviewsAutomatic(false)).statusCode).toBe(200);
    expect(await h.events('project.reviews_automatic_changed')).toHaveLength(1);

    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await queue()).toMatchObject([{ kind: 'review', reason: { reason: 'reviews_off' } }]);
    expect(await readyItems()).toMatchObject([{ start: 'switch_off' }]);
    expect((await h.ticket()).review).toMatchObject({ offered: true, start: 'switch_off' });

    // On again: the scheduler starts it.
    expect((await reviewsAutomatic(true)).statusCode).toBe(200);
    expect(await tick()).toEqual(['review WEB-1']);
    expect(starts(daemon)).toHaveLength(2);
  });

  it('off: Start review starts it at once, and a review already running goes on', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    expect((await reviewsAutomatic(false)).statusCode).toBe(200);

    const started = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(started.statusCode, started.body).toBe(201);
    const review = Run.parse(started.json());
    await h.working(daemon, review.id);
    expect((await h.ticket()).review).toMatchObject({ offered: false, start: null });

    // Turned on and off again while it runs: the run is not touched.
    expect((await reviewsAutomatic(true)).statusCode).toBe(200);
    expect((await reviewsAutomatic(false)).statusCode).toBe(200);
    expect((await h.run(review.id)).status).toBe('running');
    expect(
      daemon.received.some(
        (message) => message.type === 'run.stop' && message.payload.runId === review.id,
      ),
    ).toBe(false);
  });

  it('off: fixes still start by themselves; the review after the fix waits', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    expect((await reviewsAutomatic(false)).statusCode).toBe(200);
    expect(
      (
        await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
          comment: 'Also add a link to the map.',
        })
      ).statusCode,
    ).toBe(200);

    expect(await tick()).toEqual(['fix_review WEB-1']);
    await builds(daemon);
    expect(await tick()).toEqual([]);
    expect(await queue()).toMatchObject([{ kind: 'review', reason: { reason: 'reviews_off' } }]);
  });

  it('refuses an archived project, a value that is not true or false, and a stranger', async () => {
    await h.start();
    expect(
      (await h.call('PUT', '/api/projects/WEB/reviews-automatic', { on: 'no' })).statusCode,
    ).toBe(400);
    expect((await h.call('PUT', '/api/projects/WEB/reviews-automatic', {})).statusCode).toBe(400);
    const anonymous = await h.t.app.inject({
      method: 'PUT',
      url: '/api/projects/WEB/reviews-automatic',
      payload: { on: false },
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await h.call('POST', '/api/projects/WEB/archive')).statusCode).toBe(200);
    expect((await reviewsAutomatic(false)).statusCode).toBe(409);
    const [project] = await h.t.db.select().from(schema.projects);
    expect(project?.reviewsAutomatic).toBe(true);
  });

  it('a ticket held after a stopped review says so, not that it starts by itself', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(daemon);
    expect(await tick()).toEqual(['review WEB-1']);
    const review = await latestRun();
    await h.working(daemon, review.id);
    expect((await h.call('POST', `/api/runs/${review.id}/stop`)).statusCode).toBe(200);
    await eventually('Ready for review again', async () => {
      expect(
        TicketDetail.parse((await h.call('GET', '/api/projects/WEB/tickets/1')).json()).review,
      ).toMatchObject({ offered: true, start: 'held' });
    });
    expect(await readyItems()).toMatchObject([{ start: 'held' }]);
  });
});

describe('a daemon of the previous protocol (09, section 6; lot 5 step B)', () => {
  it('stays connected but takes no run of any kind, and every screen says to update it', async () => {
    await h.start();
    await h.createTicket({ title: 'Contact form' });
    const laptop = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1']);
    await builds(laptop.daemon);
    await h.createTicket({ title: 'Opening hours' });

    // The same machine, its daemon now of protocol 2 (0.5.0).
    await laptop.daemon.close();
    await eventually('the machine offline', async () => {
      const [row] = await h.t.db
        .select({ status: schema.machines.status })
        .from(schema.machines)
        .where(eq(schema.machines.id, laptop.id));
      expect(row?.status).toBe('offline');
    });
    const old = await h.connect(laptop.token, { protocolVersion: 2, daemonVersion: '0.5.0' });
    const outdated = { why: 'unusable', reasons: [{ type: 'daemon_outdated' }] };

    // Neither the review of WEB-1 nor the implement run of WEB-2 starts by itself.
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    const candidates = await queue();
    expect(candidates.map((candidate) => candidate.kind).sort()).toEqual(['implement', 'review']);
    for (const candidate of candidates) {
      expect(candidate.reason).toMatchObject({ machines: [{ unavailable: outdated }] });
    }
    // Nor by the owner: Run now and Start review are refused for the same reason.
    for (const path of ['/api/projects/WEB/tickets/2/run', '/api/projects/WEB/tickets/1/review']) {
      const refused = await h.call('POST', path);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.stringify(refused.json())).toContain('daemon_outdated');
    }
    expect(starts(old)).toEqual([]);

    // The machine page and Needs you say to update it, to this server's version.
    const machine = await h.call('GET', `/api/machines/${laptop.id}`);
    expect(machine.json()).toMatchObject({
      state: 'online',
      protocolVersion: 2,
      unusable: [{ type: 'daemon_outdated', daemonVersion: '0.5.0', serverProtocolVersion: 3 }],
    });
    const items = NeedsYouResponse.parse((await h.call('GET', '/api/needs-you')).json()).items;
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'daemon_outdated', daemonVersion: '0.5.0' }),
    );
  });
});
