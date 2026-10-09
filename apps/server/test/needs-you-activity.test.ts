import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  AccountListResponse,
  LiveRunsResponse,
  NeedsYouResponse,
  RUN_HISTORY_PAGE_SIZE,
  Run,
  RunHistoryResponse,
  ServerAddressResponse,
  TicketDetail,
  type RunStart,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';
import { RunHarness } from './run-harness.js';

// "Needs you", Live runs, History and the Add machine address check (lot 2 step L2; 02, sections
// 4, 7 and 9).

const h = new RunHarness();
let other: TestApp | null = null;

afterEach(async () => {
  await h.stop();
  await other?.close();
  other = null;
});

const REPORT = {
  criteria: [
    { index: 0, status: 'met', justification: 'ContactForm renders the form' },
    { index: 1, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

function limit(runId: string, kind: 'detected' | 'suspected', resetsAt: string | null = null) {
  return {
    type: 'run.quota_limited' as const,
    id: randomUUID(),
    payload:
      kind === 'detected'
        ? {
            runId,
            kind,
            resetsAt,
            evidence: {
              signal: 'stop_failure' as const,
              error: 'rate_limit' as const,
              message: "You've hit your session limit",
              statusLine: null,
            },
          }
        : {
            runId,
            kind,
            evidence: {
              signal: 'stop_failure' as const,
              error: 'overloaded' as const,
              message: 'API Error: overloaded',
              statusLine: null,
            },
          },
  };
}

async function acknowledged(
  daemon: ScriptedDaemon,
  message: Parameters<ScriptedDaemon['request']>[0],
) {
  expect(await daemon.request(message)).toMatchObject({ type: 'ack', payload: { ok: true } });
}

async function needsYou(): Promise<NeedsYouResponse> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json());
}

/** The run submits its work, CI passes and the run ends: the ticket is `in_review`. */
async function submitted(daemon: ScriptedDaemon, run: { runId: string; runToken: string }) {
  await h.ok(daemon, run.runToken, 'ticket_submit', REPORT);
  await h.ciPasses(daemon, run.runId);
}

describe('Needs you (02, section 4)', () => {
  it('lists questions, proposed tickets, finished work and paused runs oldest first, with the accounts', async () => {
    await h.start();
    await h.createTicket();
    await h.createTicket({ title: 'Opening hours' });
    await h.createTicket({ title: 'Menu page' });
    const { daemon } = await h.machine('Laptop', 3);

    const one = await h.running(daemon, 1);
    await h.ok(daemon, one.runToken, 'ticket_ask', { question: 'Which e-mail address?' });
    const two = await h.running(daemon, 2);
    await h.ok(daemon, two.runToken, 'ticket_create', {
      type: 'bug',
      title: 'Footer link is broken',
      description: 'The footer links to /contakt.',
      acceptance_criteria: ['The footer links to the contact page'],
      priority: 'normal',
    });
    await submitted(daemon, two);
    const three = await h.running(daemon, 3);
    // Detected without a reset time: the account is limited for the fallback delay, estimated.
    await acknowledged(daemon, limit(three.runId, 'detected'));

    const { items, accounts } = await needsYou();
    expect(items.map((item) => item.type)).toEqual([
      'question',
      'ticket_proposed',
      'work_to_check',
      'run_paused',
    ]);
    const since = items.map((item) => ('since' in item ? item.since : ''));
    expect(since).toEqual([...since].sort());
    expect(items).toMatchObject([
      {
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        question: { kind: 'question', body: 'Which e-mail address?' },
      },
      {
        ticket: { number: 4, title: 'Footer link is broken' },
        agent: { key: 'web_dev' },
      },
      {
        ticket: { number: 2, title: 'Opening hours' },
        summary: 'Adds the contact form.',
        runId: two.runId,
      },
      {
        ticket: { number: 3, title: 'Menu page' },
        run: {
          id: three.runId,
          pauseReason: 'usage_limit',
          resumeAfter: { estimated: true },
        },
      },
    ]);
    expect(accounts).toMatchObject([
      { label: 'Laptop account', state: 'limited', limitedUntilEstimated: true },
    ]);
    const listed = AccountListResponse.parse((await h.call('GET', '/api/accounts')).json());
    expect(listed.accounts[0]).toMatchObject({ state: 'limited', limitedUntilEstimated: true });

    // Answered, accepted, done and stopped: nothing is left.
    expect(
      (await h.call('POST', '/api/projects/WEB/tickets/1/answer', { body: 'hello@bakery.test' }))
        .statusCode,
    ).toBe(200);
    expect((await h.call('POST', '/api/projects/WEB/tickets/4/accept')).statusCode).toBe(200);
    expect(
      (await h.call('POST', '/api/projects/WEB/tickets/2/mark-done', { comment: 'Checked' }))
        .statusCode,
    ).toBe(200);
    expect((await h.call('POST', `/api/runs/${three.runId}/stop`)).statusCode).toBe(200);
    expect((await needsYou()).items).toEqual([]);
  });

  it('gives a run paused on a detected limit its reset time, not estimated', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    const one = await h.running(daemon, 1);
    await acknowledged(daemon, limit(one.runId, 'detected', resetsAt));

    const { items, accounts } = await needsYou();
    expect(items).toMatchObject([
      { type: 'run_paused', run: { resumeAfter: { at: resetsAt, estimated: false } } },
    ]);
    expect(accounts).toMatchObject([
      { state: 'limited', limitedUntil: resetsAt, limitedUntilEstimated: false },
    ]);
    // Resume is refused until then (07, section 5.2).
    const resume = await h.call('POST', `/api/runs/${one.runId}/resume`);
    expect(resume.statusCode).toBe(409);
  });

  it('lets a run paused on a suspected limit be resumed at once, the account unchanged', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const one = await h.running(daemon, 1);
    await acknowledged(daemon, limit(one.runId, 'suspected'));
    const { items, accounts } = await needsYou();
    expect(items).toMatchObject([
      { type: 'run_paused', run: { pauseReason: 'suspected_usage_limit', resumeAfter: null } },
    ]);
    expect(accounts).toMatchObject([{ state: 'available', limitedUntil: null }]);
    expect((await h.call('POST', `/api/runs/${one.runId}/resume`)).statusCode).toBe(200);
  });
});

describe('Request changes from in_review (04, section 2; lot 2 step L2)', () => {
  it('sends the work back with its comment, keeps the attempt count, and the next run reads it', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const first = await h.running(daemon);
    await submitted(daemon, first);
    expect((await h.ticket()).status).toBe('in_review');

    const response = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Also check the phone number.',
    });
    expect(response.statusCode, response.body).toBe(200);
    const ticket = TicketDetail.parse(response.json());
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(ticket.timeline.at(-1)).toMatchObject({
      type: 'status_change',
      actor: 'owner',
      from: 'in_review',
      to: 'todo',
    });
    const [event] = (await h.events('ticket.status_changed')).filter(
      (row) => (row.payload as { action: string }).action === 'request_changes',
    );
    expect(event).toMatchObject({ actor: 'owner', payload: { from: 'in_review', to: 'todo' } });
    expect((await needsYou()).items).toEqual([]);

    // Run now, as the confirmation offers: the first message holds the comment and the earlier work.
    const again = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(again.statusCode, again.body).toBe(201);
    const next = Run.parse(again.json());
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === next.id,
      'the second run.start',
    );
    expect(start.payload.initialPrompt).toContain('Also check the phone number.');
    expect(start.payload.initialPrompt).toContain('git log');
  });
});

describe('Live runs and History (02, section 7)', () => {
  it('lists active runs with their latest log entry, then ended runs with filters', async () => {
    await h.start();
    await h.createTicket();
    await h.createTicket({ title: 'Opening hours' });
    const { id: machineId, daemon } = await h.machine('Laptop', 2);
    const one = await h.running(daemon, 1);
    const two = await h.running(daemon, 2);
    await acknowledged(daemon, {
      type: 'run.events',
      id: randomUUID(),
      payload: {
        runId: one.runId,
        estimatedUsageUsd: 0.1,
        events: [
          { seq: 0, at: new Date().toISOString(), kind: 'input', tool: null, text: 'Implement' },
          {
            seq: 1,
            at: new Date().toISOString(),
            kind: 'tool_call',
            tool: 'Bash',
            text: 'pnpm test',
          },
        ],
      },
    });

    const live = LiveRunsResponse.parse((await h.call('GET', '/api/runs/live')).json());
    expect(live.runs.map((run) => [run.id, run.latestLog?.text ?? null])).toEqual([
      [one.runId, 'pnpm test'],
      [two.runId, null],
    ]);
    const onMachine = LiveRunsResponse.parse(
      (await h.call('GET', `/api/runs/live?machine=${machineId}`)).json(),
    );
    expect(onMachine.runs).toHaveLength(2);
    const elsewhere = LiveRunsResponse.parse(
      (await h.call('GET', `/api/runs/live?machine=${randomUUID()}`)).json(),
    );
    expect(elsewhere.runs).toEqual([]);

    await submitted(daemon, one);
    expect((await h.call('POST', `/api/runs/${two.runId}/stop`)).statusCode).toBe(200);
    expect(LiveRunsResponse.parse((await h.call('GET', '/api/runs/live')).json()).runs).toEqual([]);

    const history = async (query = '') => {
      const response = await h.call('GET', `/api/runs/history${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return RunHistoryResponse.parse(response.json());
    };
    expect((await history()).runs.map((run) => run.id)).toEqual([two.runId, one.runId]);
    expect((await history('?outcome=succeeded')).runs.map((run) => run.id)).toEqual([one.runId]);
    expect((await history('?outcome=cancelled')).runs).toMatchObject([
      { id: two.runId, status: 'cancelled', failureReason: 'cancelled' },
    ]);
    expect((await history('?outcome=failed')).runs).toEqual([]);
    expect((await history('?agent=web_dev&project=WEB')).runs).toHaveLength(2);
    expect((await history('?agent=architect')).runs).toEqual([]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await history(`?from=${tomorrow}`)).runs).toEqual([]);
    expect((await history(`?to=${tomorrow}`)).runs).toHaveLength(2);
    expect((await h.call('GET', '/api/runs/history?outcome=paused')).statusCode).toBe(400);
  });

  it('pages ended runs newest first, without repeating or skipping one', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const one = await h.running(daemon, 1);
    await submitted(daemon, one);
    const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, one.runId));
    if (!row?.endedAt) throw new Error('the run did not end');
    const ended = row.endedAt.getTime();
    // Earlier runs of the same ticket, one second apart; two end at the very same time.
    await h.t.db.insert(schema.runs).values(
      Array.from({ length: RUN_HISTORY_PAGE_SIZE + 2 }, (_, index) => ({
        ...row,
        id: randomUUID(),
        runTokenHash: randomUUID(),
        endedAt: new Date(ended - 1000 * (index === 0 ? 1 : index)),
      })),
    );

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = before === null ? '' : `?before=${encodeURIComponent(before)}`;
      const response = await h.call('GET', `/api/runs/history${query}`);
      expect(response.statusCode, response.body).toBe(200);
      const page = RunHistoryResponse.parse(response.json());
      seen.push(...page.runs.map((run) => run.id));
      before = page.next;
      pages += 1;
    } while (before !== null && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(RUN_HISTORY_PAGE_SIZE + 3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe(one.runId);
  });
});

describe('the address machines connect to (02, section 9.2)', () => {
  it('says when a daemon would refuse it: plain http:// outside this computer', async () => {
    const check = async (publicUrl: string) => {
      other = await startTestApp({ publicUrl });
      const cookie = await createOwner(other.app);
      const response = await other.app.inject({
        method: 'GET',
        url: '/api/machines/server-address',
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      const result = ServerAddressResponse.parse(response.json());
      await other.close();
      other = null;
      return result;
    };
    expect(await check('http://192.168.1.20:8080')).toEqual({
      address: 'http://192.168.1.20:8080',
      refusedPlainHttp: true,
    });
    expect((await check('http://localhost:8080')).refusedPlainHttp).toBe(false);
    expect((await check('https://orchestrator.example.net/')).refusedPlainHttp).toBe(false);
  });
});
