import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  ClaudeAccount,
  EnrollmentResponse,
  PROTOCOL_VERSION,
  Project,
  Run,
  TicketDetail,
  type McpCall,
  type RunStart,
  type RunState,
  TICKET_IMPORT_FORMAT,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { automaticMergerOf } from '../src/app.js';
import { markTokenInvalid, markTokenUnreadable } from '../src/github/connection.js';
import { hashCredential } from '../src/machines/credentials.js';
import { loadShippedAgents } from '../src/agents/files.js';
import { seedAgentProfiles } from '../src/agents/seed.js';
import { resetPassword } from '../src/reset-password.js';
import { branchPushedAgain } from '../src/tickets/branch-clean-up.js';
import { enroll, enrollToken, ScriptedDaemon } from './daemon-client.js';
import { fullAccount, type FakeGitHub } from './fake-github.js';
import { createOwner, OWNER, startTestApp, type TestApp } from './helpers.js';
import { startPlanningRun } from './planning-run.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';
const SESSION = '0f7a3c52-9d7e-4e8f-a4b1-222222222222';

/**
 * The application with every setting the scenario needs; login and enrollment throttling start
 * at once. It listens, for the scripted daemon.
 */
export function startEveryEventApp(github: FakeGitHub): Promise<TestApp> {
  return startTestApp({
    githubApiUrl: github.url,
    settings: { loginFailuresBeforeDelay: 1 },
    listen: true,
  });
}

/**
 * Writes every event type through the code that writes them in production: the API where the
 * owner causes it, a scripted daemon for machines, the server functions otherwise. Two projects
 * (`SHOP`, created, and `LEG`, linked) with tickets `SHOP-1` and `SHOP-2`, a Claude account and
 * the machine `Laptop`. Ends with the password reset, which revokes every session.
 */
export async function writeEveryEvent(t: TestApp, github: FakeGitHub): Promise<void> {
  const cookie = await createOwner(t.app);
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    const response = await t.app.inject({ method, url, headers: { cookie }, payload });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
    return response;
  }
  /** Waits until the event of a round's answer is written: the answer is handled meanwhile. */
  async function settledRound(type: 'run.ci_round_not_taken' | 'run.ci_round_sent') {
    for (let tries = 0; tries < 250; tries++) {
      const rows = await t.db.select().from(schema.events).where(eq(schema.events.type, type));
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${type} not written`);
  }

  async function settled(key: string) {
    for (let i = 0; i < 200; i++) {
      const project = Project.parse((await call('GET', `/api/projects/${key}`)).json());
      if (project.setup.status !== 'in_progress') return project;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`setup of ${key} did not finish`);
  }

  github.accounts.set(
    TOKEN,
    fullAccount({
      repositories: [{ name: 'legacy', private: false, files: { 'README.md': '#' } }],
    }),
  );
  await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });

  // A new public repository whose ruleset the token may not apply, then tried again.
  github.override = (request) =>
    request.method === 'POST' && request.path.endsWith('/rulesets')
      ? {
          status: 403,
          body: { message: 'Resource not accessible by personal access token' },
          headers: { 'x-accepted-github-permissions': 'administration=write' },
        }
      : undefined;
  await call('POST', '/api/projects', {
    name: 'Online Shop',
    key: 'SHOP',
    kind: 'web_app',
    repository: { origin: 'created', name: 'online-shop', private: false },
  });
  expect((await settled('SHOP')).setup.status).toBe('failed');
  github.override = undefined;
  await call('POST', '/api/projects/SHOP/setup/retry');
  expect((await settled('SHOP')).setup.status).toBe('ready');
  await call('PATCH', '/api/projects/SHOP', { name: 'Online <b>Shop</b>' });
  // Start reviews by themselves off, then on again (lot 4 step D3).
  await call('PUT', '/api/projects/SHOP/reviews-automatic', { on: false });
  await call('PUT', '/api/projects/SHOP/reviews-automatic', { on: true });
  // A new web app requires browser-tests (lot 5 step C2), which the scripted machine below lacks:
  // removed, so its runs start there as before.
  await call('PUT', '/api/projects/SHOP/required-capabilities', { capabilities: [] });

  await call('POST', '/api/projects', {
    name: 'Legacy',
    key: 'LEG',
    kind: 'website',
    repository: { origin: 'linked', name: 'legacy' },
  });
  expect((await settled('LEG')).setup.status).toBe('ready');
  await call('POST', '/api/projects/LEG/harness/check');

  await call('POST', '/api/projects/SHOP/tickets', {
    type: 'feature',
    title: 'Cart',
    assignee: 'web_dev',
  });
  await call('POST', '/api/projects/SHOP/tickets', { type: 'bug', title: 'Checkout' });
  await call('PATCH', '/api/projects/SHOP/tickets/2', {
    title: 'Checkout **fails**',
    assignee: 'architect',
  });
  await call('POST', '/api/projects/SHOP/tickets/2/dependencies', { blockedBy: 1 });
  await call('DELETE', '/api/projects/SHOP/tickets/2/dependencies/1');
  // A server started with a changed profile file (`agent_profile.created` came with the start).
  const shipped = await loadShippedAgents();
  await seedAgentProfiles(t.db, {
    ...shipped,
    profiles: shipped.profiles.map((profile) => ({ ...profile, shippedHash: 'changed' })),
  });
  await call('POST', '/api/projects/SHOP/tickets/1/comments', { body: 'Looks *good*' });
  await call('POST', '/api/projects/SHOP/tickets/1/mark-done', { comment: 'Done by hand' });

  await call('PUT', '/api/settings/sessionLifetimeDays', { value: 7 });
  await call('DELETE', '/api/settings/sessionLifetimeDays');
  await call('PUT', '/api/projects/SHOP/settings/ciWaitTimeoutMinutes', { value: 30 });
  await call('DELETE', '/api/projects/SHOP/settings/ciWaitTimeoutMinutes');

  await call('POST', '/api/projects/LEG/tickets/import', {
    text: JSON.stringify({
      format: TICKET_IMPORT_FORMAT,
      tickets: [{ key: 'readme', type: 'docs', title: 'Readme' }],
    }),
  });
  await call('POST', '/api/requests', { body: 'A contact form', project: 'SHOP' });
  await call('POST', '/api/requests/1/comments', { body: 'No e-mail.' });
  await call('POST', '/api/projects/LEG/archive');
  await call('POST', '/api/projects/LEG/unarchive');

  const account = ClaudeAccount.parse(
    (await call('POST', '/api/accounts', { label: 'Personal Max', plan: 'max_5x' })).json(),
  );
  await call('PATCH', `/api/accounts/${account.id}`, { maxConcurrentRuns: 2 });
  await call('PUT', '/api/time-zone', { timeZone: 'Europe/Paris' });
  await call('PATCH', `/api/accounts/${account.id}`, {
    schedule: [{ days: ['saturday', 'sunday'], start: '00:00', end: '24:00' }],
    dailyBudget: { kind: 'estimated_usage', usd: 5 },
  });
  await call('POST', `/api/accounts/${account.id}/stop-new-runs`);
  await call('POST', `/api/accounts/${account.id}/resume`);
  const { machine, enrollment } = EnrollmentResponse.parse(
    (await call('POST', '/api/machines', { name: 'Laptop', accountId: account.id })).json(),
  );
  const token = await enrollToken(t.url, enrollment.code);
  const daemon = await ScriptedDaemon.connect(t.url, token);
  expect((await daemon.hello()).accepted).toBe(true);
  // A run of SHOP-2: a usage limit without a reset time, a Resume once the limit time has passed,
  // then a start with a Claude Code too old.
  const created = Run.parse((await call('POST', '/api/projects/SHOP/tickets/2/run')).json());
  const start = await daemon.find((message) => message.type === 'run.start', 'run.start');
  daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
  const runState = (payload: object) =>
    daemon.request({
      type: 'run.state',
      id: randomUUID(),
      payload: {
        runId: created.id,
        at: new Date().toISOString(),
        claudeSessionId: SESSION,
        sessionAlive: true,
        ...payload,
      },
    } as RunState);
  await runState({ state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION });
  await runState({ state: 'working' });
  // The agent's progress line (shown at once, the first one) and an accepted submission.
  const tool = async (payload: McpCall['payload']) => {
    const result = await daemon.request({ type: 'mcp.call', id: randomUUID(), payload });
    expect(result).toMatchObject({ type: 'mcp.result', payload: { ok: true } });
  };
  const runToken = (start as RunStart).payload.runToken;
  await tool({ tool: 'ticket_progress', runToken, input: { text: 'Writing the tests' } });
  const shop2 = TicketDetail.parse((await call('GET', '/api/projects/SHOP/tickets/2')).json());
  // A submission refused first: its test file is not changed on the branch.
  const refused = await daemon.request({
    type: 'mcp.call',
    id: randomUUID(),
    payload: {
      tool: 'ticket_submit',
      runToken,
      input: {
        criteria: shop2.acceptanceCriteria.map((_, index) => ({
          index,
          status: 'met',
          justification: 'Checked by its test',
        })),
        tests: { paths: ['src/other.test.ts'], justification: null },
        docs: { paths: [], justification: 'Nothing user-facing' },
        adrs: [],
        summary: 'Everything done',
      },
      workspace: {
        clean: true,
        branch: {
          name: 't/2-work',
          head: 'a'.repeat(40),
          commitsAhead: [{ hash: 'a'.repeat(40), subject: 'Do the work' }],
          notOnGitHub: { listed: ['a'.repeat(40)], count: 1 },
        },
        push: { status: 'pushed', head: 'a'.repeat(40) },
        changedFiles: { listed: ['src/app.test.ts'], count: 1 },
      },
    } as McpCall['payload'],
  });
  expect(refused).toMatchObject({ type: 'mcp.result', payload: { ok: false } });
  // The push the facts report, on the fake GitHub; GitHub creates the pull request but its
  // answer never arrives (`ticket.pull_request_not_opened`).
  const shop = github.repository('octo-owner', 'online-shop');
  const [shopTicket] = await t.db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, shop2.id));
  const shopBranch = shopTicket?.branchName ?? '';
  github.commit(shop, shopBranch, { 'src/app.test.ts': 'test\n' }, 'Do the work', 'main');
  github.alter = (request, reply) =>
    request.method === 'POST' && request.path.endsWith('/pulls') ? { status: 502 } : reply;
  await tool({
    tool: 'ticket_submit',
    runToken,
    input: {
      criteria: shop2.acceptanceCriteria.map((_, index) => ({
        index,
        status: 'met',
        justification: 'Checked by its test',
      })),
      tests: { paths: ['src/app.test.ts'], justification: null },
      docs: { paths: [], justification: 'Nothing user-facing' },
      adrs: [],
      summary: 'Everything done',
    },
    workspace: {
      clean: true,
      branch: {
        name: 't/2-work',
        head: 'a'.repeat(40),
        commitsAhead: [{ hash: 'a'.repeat(40), subject: 'Do the work' }],
        notOnGitHub: { listed: ['a'.repeat(40)], count: 1 },
      },
      push: { status: 'pushed', head: 'a'.repeat(40) },
      changedFiles: { listed: ['src/app.test.ts'], count: 1 },
    },
  });
  const pullRequest = async () => {
    for (let i = 0; i < 250; i++) {
      const [row] = await t.db.select().from(schema.tickets).where(eq(schema.tickets.id, shop2.id));
      if (row && (row.pullRequestWantedSince === null || row.pullRequestFailure !== null)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the pull request attempt did not finish');
  };
  await pullRequest();
  github.alter = undefined;
  // Closed by the owner on GitHub, then **Try again**: reopened (`ticket.pull_request_reopened`).
  github.closePullRequest(shop, 1);
  await call('POST', '/api/projects/SHOP/tickets/2/pull-request/try-again');
  // As a later accepted submission would: wanted again, then updated, then (after a merge into
  // another base, which leaves the ticket going on: `ticket.pull_request_merged`) a new one
  // opened. Server functions, as the header says, without two more runs.
  const wantAgain = () =>
    t.db
      .update(schema.tickets)
      .set({ pullRequestWantedSince: new Date() })
      .where(eq(schema.tickets.id, shop2.id));
  await wantAgain();
  await call('POST', '/api/projects/SHOP/tickets/2/pull-request/try-again');
  github.commit(shop, 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
  const rebased = await fetch(`${github.url}/repos/octo-owner/online-shop/pulls/1`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ base: 'release' }),
  });
  expect(rebased.status).toBe(200);
  github.mergePullRequest(shop, 1);
  github.commit(shop, shopBranch, { 'src/more.ts': 'more\n' }, 'More work');
  await wantAgain();
  await call('POST', '/api/projects/SHOP/tickets/2/pull-request/try-again');
  // The run waits for CI since its pull request opened (`run.ci_waiting`). As if Wait for CI to
  // start were over: GitHub unreachable at one check (`run.ci_check_failed`), then answering at
  // the next (`run.ci_check_recovered`) with no run and a conflicting pull request
  // (`run.ci_result`, a conflict, sent back to the agent as a CI round: the machine cannot take
  // it at first, `run.ci_round_not_taken`, then takes it at the next check, `run.ci_round_sent`).
  await t.db
    .update(schema.runs)
    .set({ ciWaitStartedAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(schema.runs.id, created.id));
  github.alter = () => ({ status: 502 });
  await t.ciTick();
  github.alter = (request, reply) => {
    if (request.path.includes('/actions/runs?')) {
      return { status: 200, body: { total_count: 0, workflow_runs: [] } };
    }
    if (request.path.includes('/status?')) {
      return {
        status: 200,
        body: { state: 'pending', sha: 'a'.repeat(40), total_count: 0, statuses: [] },
      };
    }
    if (request.method === 'GET' && /\/pulls\/\d+$/.test(request.path)) {
      return { ...reply, body: { ...(reply.body as object), mergeable: false } };
    }
    return reply;
  };
  await t.ciTick();
  const isRound = (message: { type: string; payload: unknown }) =>
    message.type === 'run.input' && (message.payload as { runId: string }).runId === created.id;
  const notTaken = await daemon.find(isRound, 'the CI round');
  daemon.send({
    type: 'ack',
    id: notTaken.id,
    payload: {
      ok: false,
      message: 'Downloading main from GitHub failed: GitHub could not be reached',
    },
  });
  await settledRound('run.ci_round_not_taken');
  await t.ciTick();
  const taken = await daemon.find(
    (message) => isRound(message) && message.id !== notTaken.id,
    'the CI round again',
  );
  daemon.send({ type: 'ack', id: taken.id, payload: { ok: true } });
  await settledRound('run.ci_round_sent');
  github.alter = undefined;
  await daemon.request({
    type: 'run.quota_limited',
    id: randomUUID(),
    payload: {
      runId: created.id,
      kind: 'detected',
      resetsAt: null,
      evidence: { signal: 'stop_failure', error: 'rate_limit', message: null, statusLine: null },
    },
  });
  await t.db.update(schema.claudeAccounts).set({ limitedUntil: new Date(Date.now() - 1000) });
  await call('POST', `/api/runs/${created.id}/resume`);
  await runState({ state: 'starting', claudeCodeVersion: '2.1.100' });
  // Its end, reported after the server failed it: the project's Git configuration was restored.
  await runState({
    state: 'ended',
    sessionAlive: false,
    reason: 'claude_code_unsupported',
    detail: null,
    branch: null,
    push: {
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    },
    headMoved: null,
    gitConfigRestored:
      'Found changed when the run ended (by this run or an earlier one of the project on this machine), and restored. Settings added, removed: core.hookspath.',
  });
  // **Check CI again** on that run, which ended after its round without handing in again: refused,
  // not offered (`ticket.ci_checked_again`, lot 3 step G2c).
  const again = await t.app.inject({
    method: 'POST',
    url: '/api/projects/SHOP/tickets/2/ci/check-again',
    headers: { cookie },
    payload: { runId: created.id },
  });
  expect(again.statusCode, again.body).toBe(409);

  // A review run of SHOP-3, in review with its pull request (prepared in the database, as a
  // passed CI would leave it): Quality approves while GitHub cannot be read
  // (`run.review_decided`), then the owner stops the run before its end (`run.review_discarded`).
  const shop3 = TicketDetail.parse(
    (
      await call('POST', '/api/projects/SHOP/tickets', {
        type: 'feature',
        title: 'Search',
        assignee: 'web_dev',
      })
    ).json(),
  );
  const [shop3Row] = await t.db
    .update(schema.tickets)
    .set({ status: 'in_review', pullRequestNumber: 1, pullRequestUrl: 'https://github.com/x/1' })
    .where(eq(schema.tickets.id, shop3.id))
    .returning();
  const [quality] = await t.db
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.key, 'quality'));
  const reviewToken = 'ort_every_event_review_run_token';
  const [review] = await t.db
    .insert(schema.runs)
    .values({
      projectId: shop3Row?.projectId ?? '',
      ticketId: shop3.id,
      profileId: quality?.id ?? '',
      profileVersion: 1,
      purpose: 'review',
      machineId: machine.id,
      accountId: account.id,
      status: 'running',
      attempt: 1,
      runTokenHash: hashCredential(reviewToken),
      branchName: 't/3-search',
      baseBranch: 'main',
      reviewCommit: 'd'.repeat(40),
      acknowledgedAt: new Date(),
    })
    .returning();
  github.alter = (request, reply) =>
    request.method === 'GET' && /\/pulls\/\d+$/.test(request.path) ? { status: 502 } : reply;
  await tool({
    tool: 'review_approve',
    runToken: reviewToken,
    input: { summary: 'Good to merge.' },
  });
  github.alter = undefined;
  await call('POST', `/api/runs/${review?.id ?? ''}/stop`);

  // Two more review runs approving, applied at their end: the comment review posted on pull
  // request #1 of online-shop (`ticket.review_posted`), and refused for a pull request GitHub
  // does not have (`ticket.review_not_posted`; lot 3 step H3). With Merge automatically on
  // (`project.merges_automatic_changed`, lot 5 step 5bis B), the approval of the pull request
  // GitHub does not have fails its merge (`ticket.automatic_merge_failed`).
  await call('PUT', '/api/projects/SHOP/merges-automatic', { on: true });
  for (const [title, pullRequest] of [
    ['Cart', 1],
    ['Checkout', 999],
  ] as const) {
    const ticket = TicketDetail.parse(
      (
        await call('POST', '/api/projects/SHOP/tickets', {
          type: 'feature',
          title,
          assignee: 'web_dev',
        })
      ).json(),
    );
    await t.db
      .update(schema.tickets)
      .set({
        status: 'in_review',
        pullRequestNumber: pullRequest,
        pullRequestUrl: 'https://github.com/x/1',
        pullRequestState: 'open',
      })
      .where(eq(schema.tickets.id, ticket.id));
    const token = `ort_every_event_review_${String(pullRequest)}`;
    const [run] = await t.db
      .insert(schema.runs)
      .values({
        projectId: shop3Row?.projectId ?? '',
        ticketId: ticket.id,
        profileId: quality?.id ?? '',
        profileVersion: 1,
        purpose: 'review',
        machineId: machine.id,
        accountId: account.id,
        status: 'running',
        attempt: 1,
        runTokenHash: hashCredential(token),
        branchName: `t/${String(ticket.number)}-review`,
        baseBranch: 'main',
        reviewCommit: 'e'.repeat(40),
        acknowledgedAt: new Date(),
      })
      .returning();
    github.alter = (request, reply) =>
      request.method === 'GET' && /\/pulls\/\d+$/.test(request.path) ? { status: 502 } : reply;
    await tool({ tool: 'review_approve', runToken: token, input: { summary: 'Good to merge.' } });
    github.alter = undefined;
    await daemon.request({
      type: 'run.state',
      id: randomUUID(),
      payload: {
        runId: run?.id ?? '',
        at: new Date().toISOString(),
        claudeSessionId: null,
        sessionAlive: false,
        state: 'ended',
        reason: 'submitted',
        detail: null,
        branch: null,
        push: null,
        headMoved: false,
        movedHead: null,
        gitConfigRestored: null,
        download: null,
      },
    });
  }
  for (const type of [
    'ticket.review_posted',
    'ticket.review_not_posted',
    'ticket.automatic_merge_failed',
  ] as const) {
    for (let tries = 0; ; tries++) {
      const written = await t.db.select().from(schema.events).where(eq(schema.events.type, type));
      if (written.length > 0) break;
      if (tries > 100) throw new Error(`no ${type} event`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // A merge sent before a stop, whose answer was lost, found merged on GitHub with the approved
  // commit (`ticket.merged_automatically`; lot 5 step 5bis B).
  const wishlist = TicketDetail.parse(
    (
      await call('POST', '/api/projects/SHOP/tickets', {
        type: 'feature',
        title: 'Wishlist',
        assignee: 'web_dev',
      })
    ).json(),
  );
  const wishlistBranch = `t/${String(wishlist.number)}-wishlist`;
  const wishlistHead = github.commit(
    shop,
    wishlistBranch,
    { 'src/wishlist.ts': 'export {};\n' },
    'Add the wishlist',
    'main',
  );
  const opened = await fetch(`${github.url}/repos/octo-owner/online-shop/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ head: wishlistBranch, base: 'main', title: 'Wishlist', body: '' }),
  });
  expect(opened.status).toBe(201);
  const wishlistPull = ((await opened.json()) as { number: number; html_url: string }).number;
  await t.db
    .update(schema.tickets)
    .set({
      status: 'awaiting_merge',
      branchName: wishlistBranch,
      pullRequestNumber: wishlistPull,
      pullRequestUrl: `https://github.com/octo-owner/online-shop/pull/${String(wishlistPull)}`,
      pullRequestState: 'open',
      automaticMerge: {
        state: 'sent',
        pullRequest: wishlistPull,
        commit: wishlistHead,
        wantedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.tickets.id, wishlist.id));
  github.mergePullRequest(shop, wishlistPull, 'squash');
  await automaticMergerOf(t.app).check();
  await call('PUT', '/api/projects/SHOP/merges-automatic', { on: false });

  // A third request for changes on a ticket at Most review rounds per ticket (2) stops it
  // (`ticket.stopped`), then the owner's Try again (`ticket.tried_again`; lot 3 step I).
  const filters = TicketDetail.parse(
    (
      await call('POST', '/api/projects/SHOP/tickets', {
        type: 'feature',
        title: 'Filters',
        assignee: 'web_dev',
      })
    ).json(),
  );
  await t.db
    .update(schema.tickets)
    .set({ status: 'in_review', reviewRounds: 2 })
    .where(eq(schema.tickets.id, filters.id));
  const roundsToken = 'ort_every_event_review_rounds';
  const [rounds] = await t.db
    .insert(schema.runs)
    .values({
      projectId: shop3Row?.projectId ?? '',
      ticketId: filters.id,
      profileId: quality?.id ?? '',
      profileVersion: 1,
      purpose: 'review',
      machineId: machine.id,
      accountId: account.id,
      status: 'running',
      attempt: 1,
      runTokenHash: hashCredential(roundsToken),
      branchName: `t/${String(filters.number)}-filters`,
      baseBranch: 'main',
      reviewCommit: 'f'.repeat(40),
      acknowledgedAt: new Date(),
    })
    .returning();
  github.alter = (request, reply) =>
    request.method === 'GET' && /\/pulls\/\d+$/.test(request.path) ? { status: 502 } : reply;
  await tool({
    tool: 'review_request_changes',
    runToken: roundsToken,
    input: { points: [{ body: 'Sort the filters.' }] },
  });
  github.alter = undefined;
  await daemon.request({
    type: 'run.state',
    id: randomUUID(),
    payload: {
      runId: rounds?.id ?? '',
      at: new Date().toISOString(),
      claudeSessionId: null,
      sessionAlive: false,
      state: 'ended',
      reason: 'submitted',
      detail: null,
      branch: null,
      push: null,
      headMoved: false,
      movedHead: null,
      gitConfigRestored: null,
      download: null,
    },
  });
  await call('POST', `/api/projects/SHOP/tickets/${String(filters.number)}/try-again`);

  // Lot 4 step D2b: a run the owner stops holds its ticket (`ticket.held`, also written by the
  // review stopped above), Cancel releases it (`ticket.released`); two starts the machine refuses
  // (Machine failures before asking you, 2) give "could not start" (`ticket.could_not_start`).
  const [webDev] = await t.db
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.key, 'web_dev'));
  let refusedTicket: TicketDetail | undefined;
  for (const [title, status] of [
    ['Held', 'running'],
    ['Refused', 'dispatched'],
    ['Refused', 'dispatched'],
  ] as const) {
    const created =
      title === 'Refused' && refusedTicket
        ? refusedTicket
        : TicketDetail.parse(
            (
              await call('POST', '/api/projects/SHOP/tickets', {
                type: 'feature',
                title,
                assignee: 'web_dev',
              })
            ).json(),
          );
    if (title === 'Refused') refusedTicket = created;
    await t.db
      .update(schema.tickets)
      .set({ status: 'in_progress' })
      .where(eq(schema.tickets.id, created.id));
    const dispatchMessageId = randomUUID();
    const [row] = await t.db
      .insert(schema.runs)
      .values({
        projectId: shop3Row?.projectId ?? '',
        ticketId: created.id,
        profileId: webDev?.id ?? '',
        profileVersion: 1,
        purpose: 'implement',
        machineId: machine.id,
        accountId: account.id,
        status,
        attempt: 1,
        runTokenHash: hashCredential(`ort_every_event_${randomUUID()}`),
        branchName: `t/${String(created.number)}-${title.toLowerCase()}`,
        baseBranch: 'main',
        dispatchMessageId,
        dispatchKind: 'start',
        acknowledgedAt: status === 'running' ? new Date() : null,
      })
      .returning();
    if (status === 'running') {
      await call('POST', `/api/runs/${row?.id ?? ''}/stop`);
      await call('POST', `/api/projects/SHOP/tickets/${String(created.number)}/cancel`);
    } else {
      daemon.send({
        type: 'ack',
        id: dispatchMessageId,
        payload: { ok: false, message: 'the daemon is stopping' },
      });
      for (let tries = 0; ; tries++) {
        const [refused] = await t.db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, row?.id ?? ''));
        // A refused start is cancelled, not counted (07, section 3).
        if (refused?.status === 'cancelled') break;
        if (tries > 100) throw new Error('the refused start was not cancelled');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  const couldNotStart = await t.db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.type, 'ticket.could_not_start'));
  if (couldNotStart.length === 0) throw new Error('no ticket.could_not_start event');

  // The Checkout ticket (pull request #999, which GitHub does not have) cancelled while its pull
  // request reads open: Cancel's close refused (`ticket.pull_request_not_closed`), and the watch
  // cannot read it (`project.pull_request_watch_failed`; lot 3 step J3a). Then read as closed, it
  // is no longer watched.
  const [checkout] = await t.db
    .update(schema.tickets)
    .set({ pullRequestState: 'open' })
    .where(eq(schema.tickets.pullRequestNumber, 999))
    .returning();
  await call('POST', `/api/projects/SHOP/tickets/${String(checkout?.number ?? 0)}/cancel`);
  for (let tries = 0; ; tries++) {
    const written = await t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, 'ticket.pull_request_not_closed'));
    if (written.length > 0) break;
    if (tries > 100) throw new Error('no ticket.pull_request_not_closed event');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await t.ciTick();
  await t.db
    .update(schema.tickets)
    .set({ pullRequestState: 'closed', pullRequestCloseWantedAt: null })
    .where(eq(schema.tickets.id, checkout?.id ?? ''));

  // SHOP-2's pull request closed on GitHub (`ticket.pull_request_closed`), at a check that reads
  // every watched pull request again (`project.pull_request_watch_recovered`). Reopen pull request
  // refused once (`ticket.pull_request_not_reopened`), then done (`ticket.pull_request_reopened`;
  // lot 3 step J3a); merged on GitHub (`ticket.pull_request_merged`: SHOP-2 done; lot 3 step J1).
  github.closePullRequest(shop, 2);
  await t.ciTick();
  github.alter = (request, reply) =>
    request.method === 'PATCH' && request.path.endsWith('/pulls/2')
      ? { status: 422, body: { message: 'Validation Failed' } }
      : reply;
  await call('POST', '/api/projects/SHOP/tickets/2/pull-request/reopen');
  github.alter = undefined;
  await call('POST', '/api/projects/SHOP/tickets/2/pull-request/reopen');
  // SHOP-2 on Awaiting merge (set directly): its pull request read by itself for `mergeable` at
  // each check, found in conflict with main (`ticket.pull_request_conflict`), then mergeable once
  // main is reverted (`ticket.pull_request_conflict_gone`; lot 3 step J3b). GitHub answers null
  // at the first read after main moved.
  await t.db
    .update(schema.tickets)
    .set({ status: 'awaiting_merge' })
    .where(eq(schema.tickets.number, 2));
  github.commit(shop, 'main', { 'src/more.ts': 'other\n' }, 'Conflicting work');
  await t.ciTick();
  await t.ciTick();
  github.commit(shop, 'main', { 'src/more.ts': null }, 'Revert the conflicting work');
  await t.ciTick();
  await t.ciTick();
  github.mergePullRequest(shop, 2);
  await t.ciTick();
  // Its branch deleted after the merge, at the check that found it (`ticket.branch_deleted`;
  // lot 3 step J2a), then a push of it recorded after the deletion, as the server's function
  // does (`ticket.branch_pushed_again`).
  const [doneTicket] = await t.db.select().from(schema.tickets).where(eq(schema.tickets.number, 2));
  expect(doneTicket?.status).toBe('done');
  await t.db.transaction((tx) =>
    branchPushedAgain(tx, {
      project: { key: 'SHOP' },
      ticketId: doneTicket?.id ?? '',
      branch: doneTicket?.branchName ?? '',
      machine: 'Laptop',
      head: 'f'.repeat(40),
      now: new Date(),
    }),
  );
  // SHOP-1's clean-up wanted as a merge into the default branch would want it, while the ticket
  // is not done: kept (`ticket.branch_kept`).
  const [mergedElsewhere] = await t.db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.number, 1));
  const shop1CleanUp = {
    ticketId: mergedElsewhere?.id ?? '',
    pullRequestNumber: 1,
    branch: mergedElsewhere?.branchName ?? 't/1',
    mergedHead: 'e'.repeat(40),
    mergedInto: 'main',
    defaultBranch: 'main',
  };
  await t.db.insert(schema.branchCleanUps).values({ ...shop1CleanUp, target: 'github' });
  // The same on Laptop (`ticket.machine_branch_kept`; lot 3 step J2b).
  await t.db
    .insert(schema.branchCleanUps)
    .values({ ...shop1CleanUp, target: 'machine', machineId: machine.id });
  await t.ciTick();
  // SHOP-2's local branch on Laptop, asked at the check that found the merge, deleted there
  // (`ticket.machine_branch_deleted`).
  const branchDelete = await daemon.find(
    (message) => message.type === 'branch.delete',
    'branch.delete',
  );
  daemon.send({
    type: 'branch.delete_result',
    id: branchDelete.id,
    payload: { outcome: 'deleted' },
  });
  for (let tries = 0; ; tries++) {
    const [row] = await t.db
      .select({ state: schema.branchCleanUps.state })
      .from(schema.branchCleanUps)
      .where(eq(schema.branchCleanUps.messageId, branchDelete.id));
    if (row?.state === 'deleted') break;
    if (tries === 100) throw new Error('the answer to branch.delete was not stored');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // Request 1's planning run asks its question, then crashes: the request is open again
  // (`request.status_changed`; lot 5 step D2a), the crash counted on it (step E2).
  const planning = await startPlanningRun(t.db, { request: 1, machineId: machine.id });
  const planningState = (payload: object) =>
    daemon.request({
      type: 'run.state',
      id: randomUUID(),
      payload: {
        runId: planning.runId,
        at: new Date().toISOString(),
        claudeSessionId: SESSION,
        sessionAlive: true,
        ...payload,
      },
    } as RunState);
  await planningState({ state: 'working' });
  await tool({
    tool: 'request_ask',
    runToken: planning.runToken,
    input: { question: 'Which pages?' },
  });
  await planningState({
    state: 'ended',
    reason: 'crashed',
    detail: null,
    branch: null,
    push: null,
    headMoved: null,
    movedHead: null,
    gitConfigRestored: null,
    download: null,
    sessionAlive: false,
  });
  // Request 1's next planning run, stopped by the owner: the request is stopped
  // (`request.stopped`), then the owner's Try again (`request.tried_again`; lot 5 step E2).
  const stopping = await startPlanningRun(t.db, { request: 1, machineId: machine.id });
  await call('POST', `/api/runs/${stopping.runId}/stop`);
  await call('POST', '/api/requests/1/try-again');
  // Request 2's planning run proposes a plan (`plan.proposed`; lot 5 step E1b).
  await call('POST', '/api/requests', { body: 'A home page', project: 'SHOP' });
  const proposing = await startPlanningRun(t.db, { request: 2, machineId: machine.id });
  await daemon.request({
    type: 'run.state',
    id: randomUUID(),
    payload: {
      runId: proposing.runId,
      at: new Date().toISOString(),
      claudeSessionId: SESSION,
      sessionAlive: true,
      state: 'working',
    },
  });
  await tool({
    tool: 'plan_propose',
    runToken: proposing.runToken,
    input: {
      summary: 'A contact form.',
      tickets: [{ key: 'contact', type: 'feature', title: 'Contact form' }],
    },
  });

  // A run's process scope could not be created: the checks again while connected.
  await daemon.request({
    type: 'machine.doctor',
    id: randomUUID(),
    payload: {
      doctor: [
        {
          name: 'Process scopes',
          status: 'error',
          message: 'Process scopes could not be created for a run (Access denied)',
          link: null,
        },
      ],
    },
  });
  await call('PUT', `/api/machines/${machine.id}/capabilities`, { capabilities: ['git'] });
  await call('POST', `/api/machines/${machine.id}/disable`);
  await call('POST', `/api/machines/${machine.id}/enable`);
  // A second daemon of another version is refused; the first one stays connected.
  const outdated = await ScriptedDaemon.connect(t.url, token);
  await outdated.hello({ protocolVersion: PROTOCOL_VERSION + 1 });
  await outdated.closed;
  await call('POST', `/api/machines/${machine.id}/revoke`);
  await daemon.closed;
  // One wrong code starts the enrollment delay (loginFailuresBeforeDelay is 1).
  expect((await enroll(t.url, 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01')).status).toBe(404);

  await markTokenInvalid(t.db, 'system', 'GET /user');
  await markTokenUnreadable(t.db);
  await call('POST', '/api/auth/logout');
  const failed = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER.username, password: 'wrong password!' },
  });
  expect(failed.statusCode).toBe(401);
  await resetPassword(t.db, 'another correct horse battery');
}
