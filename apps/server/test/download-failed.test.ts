import {
  NeedsYouResponse,
  Run,
  type DodReport,
  type DownloadFailure,
  type NeedsYouItem,
  type RunStart,
  type TicketDetail,
} from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// A project download that fails at a run's start (04, section 5; owner's answers 1 and 2, lot 3
// step K2): the run ends `download_failed`, never counted and never stopping the ticket, with the
// true words in the ticket's comment and a blocking "Needs you" item with **Run now**, which goes
// when a new run starts, the ticket is done or cancelled, or the machine is revoked. A review run
// that fails so stays "Review did not finish".

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

const UNREACHABLE: DownloadFailure = {
  reason: 'unreachable',
  message:
    "fatal: unable to access 'https://github.com/owner/web.git/': Could not resolve host: github.com",
};
const NOT_FOUND: DownloadFailure = {
  reason: 'refused',
  message:
    "remote: Repository not found.\nfatal: repository 'https://github.com/owner/web.git/' not found",
};
const TOO_LONG: DownloadFailure = {
  reason: 'too_long',
  message:
    'Downloading the project from GitHub took longer than Longest push (60 seconds, in Settings > Limits) and was stopped. The first download on a new machine takes the longest.',
};
const ORCHESTRATOR: DownloadFailure = {
  reason: 'refused',
  message: 'The Orchestrator refused the credential: GitHub is not connected',
};

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function downloadItems() {
  return (await items()).filter((item) => item.type === 'download_failed');
}

/** The end report of a run whose download failed during its preparation, before any session. */
function failedDownload(runId: string, download: DownloadFailure) {
  return state(runId, {
    state: 'ended',
    reason: 'download_failed',
    detail: `The project could not be downloaded from GitHub: ${download.message}`,
    download,
  });
}

/** **Run now** (or **Start review**), acknowledged, then the download fails at preparation. */
async function downloadFails(
  daemon: ScriptedDaemon,
  download: DownloadFailure,
  path = '/api/projects/WEB/tickets/1/run',
): Promise<string> {
  const response = await h.call('POST', path);
  expect(response.statusCode, response.body).toBe(201);
  const created = Run.parse(response.json());
  const start = await daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === created.id,
    'run.start',
  );
  daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
  await h.report(daemon, state(created.id, { state: 'preparing' }));
  await h.report(daemon, failedDownload(created.id, download));
  await eventually('the run failed', async () => {
    expect((await h.run(created.id)).status).toBe('failed');
  });
  return created.id;
}

describe('a download that fails at the start of a run', () => {
  it('is not counted, never stops the ticket, says why, and leaves an item until a new run starts', async () => {
    // At 1, a counted failure would stop the ticket at once.
    await h.start({ settings: { maxFailedAttempts: 1 } });
    await h.createTicket();
    const { id, daemon } = await h.machine();

    const runId = await downloadFails(daemon, UNREACHABLE);
    expect(await h.run(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'download_failed',
      endReason: 'download_failed',
      endDetail: `The project could not be downloaded from GitHub: ${UNREACHABLE.message}`,
      download: { ...UNREACHABLE, permission: null },
    });
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0, stop: null });
    expect(comments(ticket).at(-1)).toMatchObject({
      author: 'system',
      body: "The run on machine Laptop ended: the project could not be downloaded from GitHub at its start, because GitHub could not be reached from that machine. It does not count as a failed attempt. Check that machine's connection to GitHub, then use Run now.",
    });
    expect(await h.events('ticket.stopped')).toEqual([]);
    expect(await downloadItems()).toEqual([
      {
        type: 'download_failed',
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        runId,
        machine: { id, name: 'Laptop' },
        download: { ...UNREACHABLE, permission: null },
        since: expect.any(String) as string,
      },
    ]);

    // Run now: the item goes as soon as the new run exists, while it works.
    await h.running(daemon);
    expect(await downloadItems()).toEqual([]);
  });

  it('names the permission the token needs when GitHub does not let it see the repository; goes when the ticket is cancelled', async () => {
    await h.start();
    const created = await h.createTicket();
    const { daemon } = await h.machine();
    const runId = await downloadFails(daemon, NOT_FOUND);
    expect((await h.run(runId)).download).toEqual({ ...NOT_FOUND, permission: 'contents' });
    const body = comments(await h.ticket()).at(-1)?.body ?? '';
    expect(body).toMatch(
      /^The run on machine Laptop ended: the project could not be downloaded from GitHub at its start, because GitHub refused the token: it needs access to \S+\/\S+ with the permission Contents \(Read and write\)\. It does not count as a failed attempt\. Change the token on GitHub, then use Run now\.$/,
    );
    expect(await downloadItems()).toMatchObject([
      { runId, download: { reason: 'refused', permission: 'contents' } },
    ]);
    expect(created.attemptCount).toBe(0);
    expect((await h.ticket()).attemptCount).toBe(0);

    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await downloadItems()).toEqual([]);
  });

  it('says Longest push was reached; goes when the ticket is marked as done', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    await downloadFails(daemon, TOO_LONG);
    expect(comments(await h.ticket()).at(-1)?.body).toBe(
      'The run on machine Laptop ended: the project could not be downloaded from GitHub at its start, because the download took longer than Longest push and was stopped. The first download on a new machine takes the longest. It does not count as a failed attempt. Use Run now to try again, or raise Longest push in Settings > Limits.',
    );
    expect(await downloadItems()).toHaveLength(1);
    const done = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Done by hand.',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await downloadItems()).toEqual([]);
  });

  it('says the Orchestrator did not give the token, in its words; goes when the machine is revoked', async () => {
    await h.start();
    await h.createTicket();
    const { id, daemon } = await h.machine();
    await downloadFails(daemon, ORCHESTRATOR);
    expect(comments(await h.ticket()).at(-1)?.body).toBe(
      'The run on machine Laptop ended: the project could not be downloaded from GitHub at its start, because the Orchestrator did not give the GitHub token: GitHub is not connected. It does not count as a failed attempt. Check Settings > GitHub, then use Run now.',
    );
    expect(await downloadItems()).toMatchObject([
      { download: { reason: 'refused', permission: null } },
    ]);
    const revoked = await h.call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await downloadItems()).toEqual([]);
  });
});

describe('a review run whose download fails', () => {
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

  it('keeps "Review did not finish", with the true words, never counted', async () => {
    await h.start();
    await h.createTicket();
    const { id, daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT);
    if (!answer.ok) throw new Error(JSON.stringify(answer.error));
    await h.ciPasses(daemon, runId);
    await eventually('the ticket in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });

    const review = await downloadFails(daemon, UNREACHABLE, '/api/projects/WEB/tickets/1/review');
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(comments(ticket).at(-1)?.body).toContain(
      'the project could not be downloaded from GitHub at its start, because GitHub could not be reached from that machine',
    );
    const notFinished = (await items()).filter((item) => item.type === 'review_not_finished');
    expect(notFinished).toMatchObject([
      {
        runId: review,
        machine: { id, name: 'Laptop' },
        end: { why: 'download_failed', download: { ...UNREACHABLE, permission: null } },
      },
    ]);
    expect(await downloadItems()).toEqual([]);
  });
});
