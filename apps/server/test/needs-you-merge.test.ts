import { schema } from '@orchestrator/db';
import { NeedsYouResponse, type DodReport, type NeedsYouItem } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// "Needs you" pull requests to merge (02, section 4; lot 3 step J4a), against the fake GitHub
// with a clock the test controls: the item's facts (review, CI, workflow flag, conflict, moved
// head, the watch's failure), its order, and when it goes.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
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
const SUMMARY = 'The form works and is tested.';

let clock = new Date('2026-10-14T10:00:00.000Z');

const repo = () => h.github.repository('octo-owner', 'bakery');

/** Ticket `number` implemented, submitted, CI passed: in review with its pull request open. */
async function submitted(daemon: ScriptedDaemon, number = 1) {
  const run = await h.running(daemon, number);
  const answer = await h.tool(daemon, run.runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, run.runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket(number)).status).toBe('in_review');
  });
  return { ...run, commit: h.lastPushed ?? '' };
}

/** Quality's review approving the work: the ticket on **Awaiting merge**. */
async function approved(daemon: ScriptedDaemon, number = 1) {
  const review = await h.reviewing(daemon, number);
  await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
  await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
  await eventually('the ticket awaiting merge', async () => {
    expect((await h.ticket(number)).status).toBe('awaiting_merge');
  });
}

async function skipped(number = 1) {
  const response = await h.call('POST', `/api/projects/WEB/tickets/${String(number)}/skip-review`);
  expect(response.statusCode, response.body).toBe(200);
}

async function start() {
  clock = new Date('2026-10-14T10:00:00.000Z');
  await h.start({ now: () => clock });
  return h.machine();
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

type ToMerge = Extract<NeedsYouItem, { type: 'pull_request_to_merge' }>;

async function toMerge(): Promise<ToMerge[]> {
  return (await items()).filter((item): item is ToMerge => item.type === 'pull_request_to_merge');
}

/** When the ticket's latest move to Awaiting merge was recorded. */
async function enteredAt(number: number): Promise<string> {
  const events = await h.events('ticket.status_changed');
  const moves = events.filter(
    (event) =>
      (event.payload as { ticket?: string; to?: string }).ticket === `WEB-${String(number)}` &&
      (event.payload as { to?: string }).to === 'awaiting_merge',
  );
  const last = moves.at(-1);
  if (!last) throw new Error('never on Awaiting merge');
  return new Date(last.createdAt).toISOString();
}

describe('a pull request to merge', () => {
  it('shows the link, the approval, the CI result and the workflow flag, and goes once merged', async () => {
    const { daemon } = await start();
    await h.createTicket();
    const first = await submitted(daemon);
    // The item is only for Awaiting merge: nothing while the ticket is in review.
    expect(await toMerge()).toEqual([]);
    await h.t.db
      .update(schema.tickets)
      .set({ workflowChanges: true, workflowReason: 'changed' })
      .where(eq(schema.tickets.number, 1));
    await approved(daemon);

    const [item, ...others] = await toMerge();
    expect(others).toEqual([]);
    expect(item).toEqual({
      type: 'pull_request_to_merge',
      ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
      pullRequest: { number: 1, url: expect.stringContaining('/pull/1') as string },
      review: {
        kind: 'approved',
        commit: first.commit,
        summary: SUMMARY,
        at: expect.any(String) as string,
      },
      ci: { result: 'passed', commit: first.commit, checkedAgainAt: null },
      workflowFlag: 'changed',
      conflict: null,
      headMoved: null,
      watchFailure: null,
      automaticMerge: null,
      since: await enteredAt(1),
    });

    h.github.mergePullRequest(repo(), 1, 'squash');
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await toMerge()).toEqual([]);
  });

  it('says the review was skipped, and lists the items by when the wait began', async () => {
    const { daemon } = await start();
    await h.createTicket();
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 1);
    await submitted(daemon, 2);
    // Ticket 2 waits first, then ticket 1.
    await skipped(2);
    clock = new Date(clock.getTime() + 60_000);
    await approved(daemon, 1);

    const shown = await toMerge();
    expect(shown.map((item) => item.ticket.number)).toEqual([2, 1]);
    expect(shown[0]?.review).toEqual({ kind: 'skipped', at: expect.any(String) as string });
    expect(shown[0]?.workflowFlag).toBeNull();
    expect((shown[0]?.since ?? '') < (shown[1]?.since ?? '')).toBe(true);
  });

  it('carries the conflict with its filled-in request; Request changes edited is still a conflict', async () => {
    const { daemon } = await start();
    await h.createTicket();
    const first = await submitted(daemon);
    await approved(daemon);
    h.github.commit(repo(), 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Other');
    // GitHub computes `mergeable` at the first read, then answers it.
    await h.t.ciTick();
    await h.t.ciTick();

    const [item] = await toMerge();
    const request =
      'Pull request #1 conflicts with main. Merge main into the branch with `git merge origin/main`, resolve the conflicts keeping the approved work, then hand it in again.';
    expect(item?.conflict).toEqual({
      head: first.commit,
      base: 'main',
      since: expect.any(String) as string,
      request,
    });

    // The owner sends it from the item edited: the same action as the ticket page's, marked as
    // a conflict from GitHub's stored fact, never from the text.
    const asked = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Keep the footer as it is.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect((await h.ticket()).changeRequest?.request).toMatchObject({
      by: 'owner',
      conflict: { base: 'main' },
    });
    expect(await toMerge()).toEqual([]);
  });

  it('carries the moved head with its comparison', async () => {
    const { daemon } = await start();
    await h.createTicket();
    const first = await submitted(daemon);
    await skipped();
    h.github.commit(repo(), 'main', { 'other.md': 'Other\n' }, 'Other work');
    const head = h.github.updatePullRequestBranch(repo(), 1);
    await h.t.ciTick();

    const [item] = await toMerge();
    expect(item?.headMoved).toEqual({
      after: 'skipped',
      commit: first.commit,
      head,
      comparison: {
        kind: 'ahead',
        titles: ["Merge branch 'main' into t/1-contact-form", 'Other work'],
        more: 0,
      },
    });
  });

  it("carries the watch's failure while the pull request cannot be read, until it can", async () => {
    const { daemon } = await start();
    await h.createTicket();
    await submitted(daemon);
    await approved(daemon);
    h.github.override = (request) =>
      request.method === 'GET' && request.path.endsWith('/pulls/1')
        ? { status: 403, body: { message: 'Resource not accessible by personal access token' } }
        : undefined;
    await h.t.ciTick();
    const [item] = await toMerge();
    expect(item?.watchFailure).toMatchObject({
      reason: 'permission_missing',
      pullRequests: [1],
    });

    h.github.override = undefined;
    await h.t.ciTick();
    expect((await toMerge())[0]?.watchFailure).toBeNull();
  });

  it('gives way to the closed item when the pull request is closed or merged into another base', async () => {
    const { daemon } = await start();
    await h.createTicket();
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 1);
    await approved(daemon, 1);
    await submitted(daemon, 2);
    clock = new Date(clock.getTime() + 60_000);
    await skipped(2);
    expect((await toMerge()).map((item) => item.ticket.number)).toEqual([1, 2]);

    h.github.closePullRequest(repo(), 1);
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    const changed = await fetch(`${h.github.url}/repos/octo-owner/bakery/pulls/2`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'release' }),
    });
    expect(changed.status).toBe(200);
    h.github.mergePullRequest(repo(), 2, 'merge');
    await h.t.ciTick();

    const shown = await items();
    expect(shown.filter((item) => item.type === 'pull_request_to_merge')).toEqual([]);
    expect(
      shown
        .filter((item) => item.type === 'pull_request_closed')
        .map((item) => [item.ticket.number, item.mergedInto])
        // GitHub's times of the close and the merge may be the same second: any order.
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [1, null],
      [2, 'release'],
    ]);
  });
});
