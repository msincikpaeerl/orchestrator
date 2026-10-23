import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import { createTestDatabase, migrateUpTo } from '@orchestrator/db/testing';
import { createPool, endPool, runMigrations } from '@orchestrator/db';
import { RunLogResponse, STREAM_RETRY_MS, type StreamMessage } from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../src/events.js';
import { RunHarness, eventually, state } from './run-harness.js';
import { StreamClient } from './stream-client.js';

// The realtime stream (lot 2 step L; 02, section 1; ADR 0029).

type Changed = Extract<StreamMessage, { type: 'changed' }>;
type RunLog = Extract<StreamMessage, { type: 'run_log' }>;

const h = new RunHarness();
const streams: StreamClient[] = [];

async function open(cookie = h.cookie): Promise<StreamClient> {
  const stream = await StreamClient.open(h.t.url, cookie);
  streams.push(stream);
  return stream;
}

function changed(entity: Changed['entity'], id?: string) {
  return (message: StreamMessage): message is Changed =>
    message.type === 'changed' &&
    message.entity === entity &&
    (id === undefined || message.id === id);
}

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await h.stop();
});

describe('GET /api/stream', () => {
  it('is refused without a session', async () => {
    await h.start({});
    const response = await h.t.app.inject({ method: 'GET', url: '/api/stream' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'not_authenticated' } });
  });

  it('sends Server-Sent Events with the reconnection delay, and "changed" after a ticket change', async () => {
    await h.start({ settings: {} });
    const stream = await open();
    expect(stream.contentType).toBe('text/event-stream; charset=utf-8');

    const ticket = await h.createTicket();
    const message = await stream.find(changed('ticket', ticket.id), 'the new ticket');
    expect(message).toEqual({ type: 'changed', entity: 'ticket', id: ticket.id, project: 'WEB' });
    expect(stream.retryMs).toBe(STREAM_RETRY_MS);
  }, 15_000);

  it('sends only changes whose transaction was committed', async () => {
    await h.start();
    const stream = await open();
    const rolledBack = randomUUID();
    const committed = randomUUID();
    await expect(
      h.t.db.transaction(async (tx) => {
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'setting',
          entityId: rolledBack,
          type: 'setting.changed',
        });
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');
    await recordEvent(h.t.db, {
      actor: 'owner',
      entityType: 'setting',
      entityId: committed,
      type: 'setting.changed',
    });
    // The committed change comes after the rolled-back one would have.
    await stream.find(changed('setting', committed), 'the committed change');
    expect(stream.messages.filter(changed('setting', rolledBack))).toEqual([]);
  }, 15_000);

  it("notices a run's new log entries; the entries are read after the last one held", async () => {
    await h.start();
    const { daemon } = await h.machine();
    await h.createTicket();
    const { runId } = await h.running(daemon);
    const stream = await open();

    const answer = await daemon.request({
      type: 'run.events',
      id: randomUUID(),
      payload: {
        runId,
        estimatedUsageUsd: 0.12,
        events: [0, 1, 2].map((seq) => ({
          seq,
          at: new Date().toISOString(),
          kind: 'agent_text' as const,
          tool: null,
          text: `Line ${String(seq)}`,
        })),
      },
    });
    expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
    const notice = await stream.find(
      (message): message is RunLog => message.type === 'run_log' && message.run === runId,
      'the log notice',
    );
    expect(notice).toEqual({ type: 'run_log', run: runId, project: 'WEB', seq: 2 });

    const log = await h.call('GET', `/api/runs/${runId}/log?after=0`);
    expect(RunLogResponse.parse(log.json()).entries.map((entry) => entry.text)).toEqual([
      'Line 1',
      'Line 2',
    ]);
  }, 20_000);

  it("sends the branch a run's late end report adds, after the server ended the run", async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    await h.ok(daemon, runToken, 'ticket_submit', {
      criteria: [
        { number: 1, status: 'met', justification: 'The form is there' },
        { number: 2, status: 'met', justification: 'Checked by its test' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: ['docs/user/contact.md'], justification: null },
      adrs: [],
      summary: 'Adds the contact form.',
    });
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the wait for CI begun', async () => {
      expect((await h.run(runId)).ci?.since).toBeTruthy();
    });
    await h.t.ciTick();
    expect((await h.run(runId)).status).toBe('succeeded');
    // The server ended the run when CI passed; the machine's end report comes afterwards, with
    // the branch the screens show (lot 3 step G1a).
    const stream = await open();
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    await stream.find(changed('run', runId), "the run's end report");
  }, 15_000);

  it('sends each CI check of a waiting run, even one that writes no event', async () => {
    await h.start({ ci: 'queued' });
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    await h.ok(daemon, runToken, 'ticket_submit', {
      criteria: [
        { number: 1, status: 'met', justification: 'The form is there' },
        { number: 2, status: 'met', justification: 'Checked by its test' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: ['docs/user/contact.md'], justification: null },
      adrs: [],
      summary: 'Adds the contact form.',
    });
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the wait for CI begun', async () => {
      expect((await h.run(runId)).ci?.since).toBeTruthy();
    });
    // CI not finished: no event, yet the run page's CI card shows the checks and their time
    // (lot 3 step G1b).
    const stream = await open();
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('pending');
    await stream.find(changed('run', runId), 'the first CI check');
    const seen = stream.messages.filter(changed('run', runId)).length;
    await h.t.ciTick();
    await eventually('the next CI check sent', () => {
      expect(stream.messages.filter(changed('run', runId)).length).toBeGreaterThan(seen);
    });
  }, 15_000);

  it('ends at logout', async () => {
    await h.start();
    const stream = await open();
    const response = await h.call('POST', '/api/auth/logout');
    expect(response.statusCode).toBe(204);
    await stream.end('logout');
    const again = await h.t.app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: { cookie: h.cookie },
    });
    expect(again.statusCode).toBe(401);
  }, 15_000);

  it('sends keep-alives, and ends at the next one once the session is gone', async () => {
    await h.start({ streamKeepAliveMs: 50 });
    const stream = await open();
    const deadline = Date.now() + 5000;
    while (!stream.comments.includes('keep-alive')) {
      if (Date.now() > deadline) throw new Error('no keep-alive within 5000 ms');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Removed without an event, as an expiry would be.
    await h.t.db.delete(schema.sessions);
    await stream.end('session removed');
  }, 15_000);

  it('asks the screens to read everything again after the database listener reconnects', async () => {
    await h.start();
    const stream = await open();
    const { rows } = await h.t.pool.query<{ ended: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
        WHERE datname = current_database() AND query LIKE 'LISTEN %'`,
    );
    expect(rows).toEqual([{ ended: true }]);
    await stream.find(
      (message): message is Extract<StreamMessage, { type: 'resync' }> => message.type === 'resync',
      'resync',
      STREAM_RETRY_MS + 5000,
    );
    // And it listens again.
    const ticket = await h.createTicket();
    await stream.find(changed('ticket', ticket.id), 'a change after the reconnection');
  }, 20_000);
});

describe('project setup polling removed', () => {
  it('no longer serves /api/ui-settings nor the setting', async () => {
    await h.start();
    expect((await h.call('GET', '/api/ui-settings')).statusCode).toBe(404);
    const setting = await h.call('PUT', '/api/settings/projectSetupPollSeconds', { value: 5 });
    expect(setting.statusCode).toBe(404);
  });

  it('drops a stored value at the migration', async () => {
    const database = await createTestDatabase({ empty: true });
    const pool = createPool({ connectionString: database.url });
    try {
      await migrateUpTo(pool, '0010_mcp_questions');
      await pool.query(
        "INSERT INTO setting_values (name, value) VALUES ('projectSetupPollSeconds', 5), ('commentMaxLength', 5000)",
      );
      await runMigrations(pool);
      const { rows } = await pool.query<{ name: string }>('SELECT name FROM setting_values');
      expect(rows).toEqual([{ name: 'commentMaxLength' }]);
    } finally {
      await endPool(pool);
      await database.drop();
    }
  });
});
