import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  Project,
  type AutomaticMerge,
  type DodReport,
  type NeedsYouItem,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { automaticMergerOf } from '../src/app.js';
import type { ScriptedDaemon } from './daemon-client.js';
import type { RecordedRequest } from './fake-github.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// **Merge automatically** (04, section 4; lot 5 step 5bis B), against the fake GitHub: Quality's
// approval on a project with the option on wants the merge, the server checks the pull request
// and CI on the approved commit again, merges with that commit as `sha` and the method `squash`,
// and the merge detection makes the ticket done once. Every failure leaves the ticket on
// **Awaiting merge** with its reason in Needs you, and is never tried again; **Stop new runs**
// holds the merges until **Resume** (owner's answer 7).

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

const repo = () => h.github.repository('octo-owner', 'bakery');

type Machine = Awaited<ReturnType<RunHarness['machine']>>;

async function start(): Promise<Machine> {
  await h.start();
  return h.machine();
}

async function mergesAutomatic(on: boolean) {
  return h.call('PUT', '/api/projects/WEB/merges-automatic', { on });
}

/** Ticket `number` implemented, submitted, CI passed: in review with its pull request open. */
async function submitted(daemon: ScriptedDaemon, number = 1) {
  const run = await h.running(daemon, number);
  const answer = await h.tool(daemon, run.runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, run.runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket(number)).status).toBe('in_review');
  });
  return h.lastPushed ?? '';
}

/**
 * Quality approves: the ticket on **Awaiting merge**, and the automatic merge's try ended (unless
 * `held`: **Stop new runs** keeps it wanted).
 */
async function approved(daemon: ScriptedDaemon, number = 1, held?: Machine) {
  const review = await h.reviewing(daemon, number);
  // Stop new runs refuses a review's start: pressed while Quality reviews.
  if (held) await stopNewRuns(held);
  await h.ok(daemon, review.runToken, 'review_approve', { summary: 'Good to merge.' });
  await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
  await eventually('Quality approved, and the try ended', async () => {
    expect(['awaiting_merge', 'done']).toContain((await h.ticket(number)).status);
    if (!held) expect(['wanted', 'sent']).not.toContain((await stored(number))?.state);
  });
  await merges();
}

/** Every try running has ended. */
async function merges() {
  await automaticMergerOf(h.t.app).idle();
}

async function stopNewRuns(machine: Machine) {
  const response = await h.call('POST', `/api/accounts/${machine.account.id}/stop-new-runs`);
  expect(response.statusCode, response.body).toBe(200);
}

/** **Resume**, which starts a check of the merges without waiting for it; `tried` says it ran. */
async function resume(
  machine: Machine,
  tried: (merge: AutomaticMerge | null) => boolean = (merge) => merge?.state !== 'wanted',
) {
  const response = await h.call('POST', `/api/accounts/${machine.account.id}/resume`);
  expect(response.statusCode, response.body).toBe(200);
  await eventually('the held merge tried', async () => {
    expect(tried(await stored())).toBe(true);
  });
  await merges();
}

async function stored(number = 1): Promise<AutomaticMerge | null> {
  const merge = (await h.ticket(number)).pullRequest.automaticMerge?.merge;
  if (merge) return merge;
  const [row] = await h.t.db
    .select({ merge: schema.tickets.automaticMerge })
    .from(schema.tickets)
    .where(eq(schema.tickets.number, number));
  return (row?.merge ?? null) as AutomaticMerge | null;
}

const isMerge = (request: RecordedRequest) =>
  request.method === 'PUT' && /\/pulls\/\d+\/merge$/.test(request.path);

function mergeRequests() {
  return h.github.requests.filter(isMerge);
}

type ToMerge = Extract<NeedsYouItem, { type: 'pull_request_to_merge' }>;

async function toMerge(): Promise<ToMerge[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items.filter(
    (item): item is ToMerge => item.type === 'pull_request_to_merge',
  );
}

/** The single failure the ticket keeps, with its single event; the ticket still waits. */
async function failedWith(reason: string, words: string) {
  const merge = await stored();
  expect(merge).toMatchObject({ state: 'failed', reason });
  if (merge?.state !== 'failed') throw new Error('not failed');
  expect(merge.message).toContain(words);
  expect(await h.events('ticket.automatic_merge_failed')).toMatchObject([
    { payload: { ticket: 'WEB-1', reason, message: merge.message } },
  ]);
  expect((await h.ticket()).status).toBe('awaiting_merge');
  const [item] = await toMerge();
  expect(item?.automaticMerge?.merge).toMatchObject({ state: 'failed', reason });
  // Never tried again: the next GitHub check sends nothing more.
  const sent = mergeRequests().length;
  await h.t.ciTick();
  await merges();
  expect(mergeRequests()).toHaveLength(sent);
  expect((await stored())?.state).toBe('failed');
}

describe('the option', () => {
  it('is off by default, writes an event at each change and is refused once archived', async () => {
    await start();
    const before = Project.parse((await h.call('GET', '/api/projects/WEB')).json());
    expect(before.mergesAutomatic).toBe(false);
    const on = await mergesAutomatic(true);
    expect(on.statusCode, on.body).toBe(200);
    expect(Project.parse(on.json()).mergesAutomatic).toBe(true);
    // The same value again changes nothing.
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    expect((await mergesAutomatic(false)).statusCode).toBe(200);
    expect(await h.events('project.merges_automatic_changed')).toMatchObject([
      { actor: 'owner', payload: { key: 'WEB', on: true } },
      { actor: 'owner', payload: { key: 'WEB', on: false } },
    ]);
    expect((await h.call('POST', '/api/projects/WEB/archive')).statusCode).toBe(200);
    expect((await mergesAutomatic(true)).statusCode).toBe(409);
  });
});

describe('a merge done', () => {
  it('merges the approved commit with squash, makes the ticket done once and unblocks its dependents', async () => {
    const { daemon } = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    await h.createTicket({ title: 'Map page', blockedBy: [1] });
    const commit = await submitted(daemon);
    await approved(daemon);

    expect(mergeRequests()).toMatchObject([
      {
        path: '/repos/octo-owner/bakery/pulls/1/merge',
        body: { sha: commit, merge_method: 'squash' },
      },
    ]);
    expect(h.github.pullRequest(repo(), 1)).toMatchObject({ merged: true });
    const ticket = await h.ticket();
    expect(ticket.status).toBe('done');
    expect(ticket.pullRequest.automaticMerge).toEqual({
      merge: {
        state: 'merged',
        pullRequest: 1,
        commit,
        wantedAt: expect.any(String) as string,
        method: 'squash',
        mergeCommit: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
        at: expect.any(String) as string,
      },
      heldBy: [],
    });
    expect((await h.ticket(2)).blocked).toBe(false);
    expect(await h.events('ticket.merged_automatically')).toMatchObject([
      { actor: 'system', payload: { ticket: 'WEB-1', pullRequest: 1, commit, method: 'squash' } },
    ]);

    // The next GitHub check finds the same merge and does nothing more; the branch goes.
    await h.t.ciTick();
    await merges();
    expect(await h.events('ticket.pull_request_merged')).toMatchObject([
      { payload: { ticket: 'WEB-1', outcome: 'done' } },
    ]);
    expect(mergeRequests()).toHaveLength(1);
    await eventually('the branch deleted on GitHub', async () => {
      await h.t.ciTick();
      expect([...h.github.branches(repo()).keys()].filter((name) => name.startsWith('t/'))).toEqual(
        [],
      );
    });
    expect(await toMerge()).toEqual([]);
  });

  it('a lost answer: the pull request found merged with that commit is merged automatically', async () => {
    const { daemon } = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    const commit = await submitted(daemon);
    // GitHub merges, then the answer is cut.
    h.github.override = (request) => {
      if (!isMerge(request)) return undefined;
      h.github.mergePullRequest(repo(), 1, 'squash');
      return { status: 200, cut: true };
    };
    await approved(daemon);
    expect(await stored()).toMatchObject({ state: 'merged', commit, mergeCommit: null });
    expect((await h.ticket()).status).toBe('done');
    expect(await h.events('ticket.merged_automatically')).toHaveLength(1);
    expect(await h.events('ticket.pull_request_merged')).toHaveLength(1);
  });
});

describe('nothing merged', () => {
  it('with the option off: the owner merges, as before', async () => {
    const { daemon } = await start();
    await h.createTicket();
    await submitted(daemon);
    await approved(daemon);
    expect(mergeRequests()).toEqual([]);
    expect(await stored()).toBeNull();
    const [item] = await toMerge();
    expect(item?.automaticMerge).toBeNull();
  });

  it('after a skipped review (answer 3)', async () => {
    const { daemon } = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    await submitted(daemon);
    const skip = await h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
    expect(skip.statusCode, skip.body).toBe(200);
    await h.t.ciTick();
    await merges();
    expect(mergeRequests()).toEqual([]);
    expect((await h.ticket()).status).toBe('awaiting_merge');
    expect(await toMerge()).toHaveLength(1);
  });

  it('for a ticket approved before the option was turned on (answer 6)', async () => {
    const { daemon } = await start();
    await h.createTicket();
    await submitted(daemon);
    await approved(daemon);
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.t.ciTick();
    await merges();
    expect(mergeRequests()).toEqual([]);
  });

  it('once the option is turned off, or the project archived, before the try', async () => {
    const machine = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    await submitted(machine.daemon);
    await approved(machine.daemon, 1, machine);
    expect(await stored()).toMatchObject({ state: 'wanted' });
    expect((await mergesAutomatic(false)).statusCode).toBe(200);
    await resume(machine);
    expect(mergeRequests()).toEqual([]);
    expect(await stored()).toBeNull();
    expect(await h.events('ticket.automatic_merge_failed')).toEqual([]);
    expect(await toMerge()).toMatchObject([{ automaticMerge: null }]);
  });
});

describe('Stop new runs (answer 7)', () => {
  it('holds the merge, Needs you says so, and Resume merges it', async () => {
    const machine = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    await submitted(machine.daemon);
    await approved(machine.daemon, 1, machine);
    await h.t.ciTick();
    await merges();
    expect(mergeRequests()).toEqual([]);
    const [item] = await toMerge();
    expect(item?.automaticMerge).toMatchObject({
      merge: { state: 'wanted' },
      heldBy: ['Laptop account'],
    });
    expect((await h.ticket()).pullRequest.automaticMerge?.heldBy).toEqual(['Laptop account']);

    await resume(machine);
    expect(mergeRequests()).toHaveLength(1);
    expect((await h.ticket()).status).toBe('done');
  });

  it('a merge wanted and not held shows no item while it waits for GitHub, then merges at the next check', async () => {
    const machine = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    await submitted(machine.daemon);
    await approved(machine.daemon, 1, machine);
    await h.github.setReachable(false);
    await resume(machine, (merge) => merge?.state === 'wanted' && merge.waiting !== null);
    expect(await stored()).toMatchObject({
      state: 'wanted',
      waiting: { message: expect.stringContaining('could not be reached') as string },
    });
    expect(await toMerge()).toEqual([]);
    await h.github.setReachable(true);
    await h.t.ciTick();
    await merges();
    expect((await h.ticket()).status).toBe('done');
    expect(mergeRequests()).toHaveLength(1);
  });
});

describe('a failure, never tried again', () => {
  /** Approved while held, `meanwhile` changes GitHub, then Resume tries the merge. */
  async function heldThen(meanwhile: (commit: string) => void | Promise<void>) {
    const machine = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    const commit = await submitted(machine.daemon);
    await approved(machine.daemon, 1, machine);
    await meanwhile(commit);
    await resume(machine);
    return commit;
  }

  it('the head moved after the approval', async () => {
    await heldThen(() => {
      const pull = h.github.pullRequest(repo(), 1);
      h.github.commit(repo(), pull.head, { 'src/later.ts': 'export {};\n' }, 'Later work');
    });
    await failedWith('head_moved', 'is no longer the commit Quality approved');
    expect(mergeRequests()).toEqual([]);
  });

  it("GitHub's 409: the head changed just before the merge", async () => {
    await heldThen(() => {
      h.github.override = (request) =>
        isMerge(request)
          ? {
              status: 409,
              body: { message: 'Head branch was modified. Review and try the merge again.' },
            }
          : undefined;
    });
    await failedWith('head_moved', 'changed just before the merge');
    expect(mergeRequests()).toHaveLength(1);
  });

  it('CI no longer passes on the approved commit', async () => {
    await heldThen((commit) => {
      h.github.setStatus(repo(), commit, { context: 'deploy-check', state: 'failure' });
    });
    await failedWith('ci_not_passed', 'deploy-check failed');
    expect(mergeRequests()).toEqual([]);
  });

  it('nothing on GitHub tested the commit (answer 4)', async () => {
    await heldThen(() => {
      h.github.override = (request) =>
        request.method === 'GET' && request.path.includes('/actions/runs?')
          ? { status: 200, body: { total_count: 0, workflow_runs: [] } }
          : undefined;
    });
    await failedWith('no_ci', 'nothing on GitHub tested commit');
  });

  it('a conflict with the default branch: GitHub cannot merge it', async () => {
    await heldThen(() => {
      // The branch's file, written differently on main: the branch no longer merges. GitHub
      // has not computed it yet at the first read (null), so its merge answer decides.
      h.github.commit(repo(), 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Clash');
    });
    await failedWith('not_mergeable', 'Pull Request is not mergeable');
  });

  it('a conflict GitHub already computed is found before the merge is sent', async () => {
    await heldThen(async () => {
      h.github.commit(repo(), 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Clash');
      // A first read lets GitHub compute it, as GitHub's own page does.
      await fetch(`${h.github.url}/repos/octo-owner/bakery/pulls/1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    });
    await failedWith('conflict', 'conflicts with main');
    expect(mergeRequests()).toEqual([]);
  });

  it("GitHub's 405 and a refusal: the reason in GitHub's words", async () => {
    await heldThen(() => {
      h.github.override = (request) =>
        isMerge(request)
          ? { status: 405, body: { message: 'Pull Request is not mergeable' } }
          : undefined;
    });
    await failedWith('not_mergeable', 'GitHub refused the merge: Pull Request is not mergeable');
  });

  it('a missing permission is named in the token page’s words', async () => {
    await heldThen(() => {
      const account = h.github.accounts.values().next().value;
      if (account) account.permissions.contents = 'read';
    });
    await failedWith('permission_missing', 'the token lacks Contents (Read and write)');
    expect(await stored()).toMatchObject({ permission: 'contents' });
  });

  it('a lost answer with the pull request not merged', async () => {
    await heldThen(() => {
      h.github.override = (request) => (isMerge(request) ? { status: 200, cut: true } : undefined);
    });
    await failedWith('answer_lost', "GitHub's answer to the merge was lost");
  });

  it('a merge left sent by a stop is settled at the next check, never sent again', async () => {
    const machine = await start();
    expect((await mergesAutomatic(true)).statusCode).toBe(200);
    await h.createTicket();
    const commit = await submitted(machine.daemon);
    await approved(machine.daemon, 1, machine);
    const wanted = await stored();
    if (wanted?.state !== 'wanted') throw new Error('not wanted');
    // The server stopped after "sent", before GitHub's answer; GitHub had merged it.
    const facts = {
      pullRequest: wanted.pullRequest,
      commit: wanted.commit,
      wantedAt: wanted.wantedAt,
    };
    await h.t.db
      .update(schema.tickets)
      .set({ automaticMerge: { ...facts, state: 'sent', sentAt: new Date().toISOString() } })
      .where(eq(schema.tickets.number, 1));
    h.github.mergePullRequest(repo(), 1, 'squash');
    // Settled although Stop new runs is still on: nothing more is sent.
    await automaticMergerOf(h.t.app).check();
    await merges();
    expect(mergeRequests()).toEqual([]);
    expect(await stored()).toMatchObject({ state: 'merged', commit, mergeCommit: null });
    expect((await h.ticket()).status).toBe('done');
    expect(await h.events('ticket.pull_request_merged')).toHaveLength(1);
  });
});
