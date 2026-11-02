import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedBrowsers, runDaemon } from '@orchestrator/daemon/testing';
import type { FakeClaude } from '@orchestrator/daemon/testing/fake-claude';
import {
  ClaudeAccount,
  EnrollmentResponse,
  NeedsYouResponse,
  PROTOCOL_VERSION,
  Project,
  QueueResponse,
  RequestDetail,
  TicketDetail,
  type DodReport,
} from '@orchestrator/protocol';
import { schema } from '@orchestrator/db';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SUMMARY,
  TIMEOUT,
  acceptanceHooks,
  bakery,
  clock,
  commit,
  endedSucceeded,
  fake,
  h,
  home,
  json,
  machine,
  messages,
  run,
  sessionAlive,
  startDaemon,
  startHarness,
  until,
} from './acceptance-harness.js';
import { repositoryFiles, skeletonWorkflow } from './fake-github.js';

// Lot 5's acceptance scenarios (lot 5 plan, step K): requests and planning with the real server,
// the real daemon, tmux, the fake `claude` and the fake GitHub, on the shared harness of
// `acceptance-harness.ts`, in a file of their own so the CI shards can balance them. Every run is
// started by the scheduler, one `schedulerTick()` standing for each of its checks; the owner only
// answers, rejects, approves, closes and merges, through the API (owner's answers to step K).

acceptanceHooks();

/** The request text of the owner's check (lot 5 plan, "What the website must be"). */
/** What the fake does in a turn before its decision. */
type Steps = NonNullable<NonNullable<Parameters<FakeClaude['play']>[0]['turns']>[number]['steps']>;

const WEBSITE_REQUEST =
  'A simple website with a home page and a contact form. A message sent through the form is saved on the computer running the site, and the visitor sees a confirmation. No e-mail.';

describe('lot 5 acceptance scenarios, requests and planning, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + clock.ahead),
    });
    // The machine after the owner's `orchestrator-daemon browsers` (step M, item 2).
    await installedBrowsers(home);
  });

  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };
  const request = (number: number) =>
    json((v) => RequestDetail.parse(v), 'GET', `/api/requests/${String(number)}`);
  const project = (key: string) => json((v) => Project.parse(v), 'GET', `/api/projects/${key}`);
  const ticketOf = (key: string, number: number) =>
    json((v) => TicketDetail.parse(v), 'GET', `/api/projects/${key}/tickets/${String(number)}`);
  const queue = () => json((v) => QueueResponse.parse(v), 'GET', '/api/queue');
  const needsYou = async () =>
    (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items;
  /** The owner's action on a request, which must succeed. */
  const owner = (path: string, payload?: object) =>
    json((v) => RequestDetail.parse(v), 'POST', `/api/requests/${path}`, payload);
  /** The sessions the fake was asked to start, resumes included. */
  const sessions = async () => (await fake.log()).filter((entry) => entry.event === 'start').length;
  /** The fake's session of a run: its folder is named after the run. */
  async function sessionOf(runId: string) {
    const start = (await fake.log()).find(
      (entry) => entry.event === 'start' && entry.cwd === join(home.paths.home, 'worktrees', runId),
    );
    if (start?.event !== 'start') throw new Error(`no session for run ${runId}`);
    return start;
  }
  /** The new project's repository on the fake GitHub, created by the approval in K1. */
  const contactRepository = () => h.github.repository('octo-owner', 'contact-form-check');

  /** Add machine on a new account, then `orchestrator-daemon enroll`, as Help tells the owner. */
  async function enrol(maxConcurrentRuns = 1) {
    const account = await json((v) => ClaudeAccount.parse(v), 'POST', '/api/accounts', {
      label: 'Personal',
      plan: 'pro',
      maxConcurrentRuns,
    });
    const created = await json((v) => EnrollmentResponse.parse(v), 'POST', '/api/machines', {
      name: 'Laptop',
      accountId: account.id,
    });
    const enrolled = await runDaemon(['enroll', h.t.url, created.enrollment.code], home.env);
    expect(enrolled.stderr).toBe('');
    expect(enrolled.code).toBe(0);
    return created.machine.id;
  }
  /** `orchestrator-daemon start`: the machine online and usable. */
  async function started(machineId: string) {
    startDaemon();
    await until('the machine online and usable', async () => {
      const current = await machine(machineId);
      return current.online && current.unusable.length === 0;
    });
  }

  /** A DoD report meeting each of the ticket's criteria, numbered from 1 (protocol 3). */
  function reportFor(criteria: string[], summary: string): DodReport {
    return {
      criteria: criteria.map((_, index) => ({
        number: index + 1,
        status: 'met',
        justification: 'Done as the criterion says.',
      })),
      tests: { paths: [], justification: 'Covered by the checks CI runs.' },
      docs: { paths: [], justification: 'Nothing new for the owner to read.' },
      adrs: [],
      summary,
    };
  }

  /**
   * One ticket of the project `key`: implemented by the scheduler's run with `steps` then
   * `ticket_submit`, CI passed, reviewed by Quality by itself, merged by the owner on the fake
   * GitHub, done. Returns the implement run's id.
   */
  async function implementedReviewedMerged(
    key: string,
    number: number,
    steps: Steps,
  ): Promise<string> {
    const reference = `${key}-${String(number)}`;
    const current = await ticketOf(key, number);
    const report = reportFor(current.acceptanceCriteria, current.title);
    await fake.play({
      turns: [{ steps: [...steps, { do: 'mcp', tool: 'ticket_submit', arguments: report }] }],
    });
    expect(await tick()).toEqual([`implement ${reference}`]);
    const built = await latestRun();
    await until(`${reference} submitted, CI passed`, async () => {
      await h.t.ciTick();
      return endedSucceeded(built.id);
    });
    expect(await ticketOf(key, number)).toMatchObject({ status: 'in_review', attemptCount: 0 });

    await fake.play({
      turns: [{ steps: [{ do: 'mcp', tool: 'review_approve', arguments: { summary: SUMMARY } }] }],
    });
    expect(await tick()).toEqual([`review ${reference}`]);
    const review = await latestRun();
    await until(`${reference} reviewed`, () => endedSucceeded(review.id));
    expect(await ticketOf(key, number)).toMatchObject({ status: 'awaiting_merge' });

    // Automatic merge is off (owner's answer 6): the owner merges on GitHub.
    const opened = (await ticketOf(key, number)).pullRequest.opened;
    if (!opened) throw new Error(`no pull request for ${reference}`);
    h.github.mergePullRequest(contactRepository(), opened.number, 'merge');
    await until(`${reference} done`, async () => {
      await h.t.ciTick();
      return (await ticketOf(key, number)).status === 'done';
    });
    return built.id;
  }

  // The website plan, as the Project Manager proposes it: the bootstrap first, then the feature.
  const setup = {
    key: 'setup',
    type: 'chore',
    title: 'Set up the website',
    acceptance_criteria: ['The home page says what the site is for'],
    assignee: 'architect',
    bootstrap: true,
  };
  const contact = {
    key: 'contact',
    type: 'feature',
    title: 'Contact form',
    acceptance_criteria: [
      'The form asks for a name, an e-mail address and a message',
      'An accepted message is saved as one line in a file kept out of Git',
      'The visitor sees a confirmation',
    ],
    assignee: 'web_dev',
  };
  const newProject = {
    name: 'Contact form check',
    kind: 'website',
    description: 'A home page and a contact form saving messages to a file.',
  };

  it(
    'K1: a new website from a request: a question answered, a plan rejected with feedback, the second approved with the form, the repository created, the bootstrap then the feature implemented, reviewed and merged',
    async () => {
      const machineId = await enrol();
      await started(machineId);
      expect((await machine(machineId)).capabilities).toContain('browser-tests');

      // The owner's request for a new project: the scheduler's planning run asks a question.
      const created = await h.call('POST', '/api/requests', {
        body: WEBSITE_REQUEST,
        project: null,
      });
      expect(created.statusCode, created.body).toBe(201);
      const QUESTION = 'Should the home page show anything besides the contact form?';
      const ANSWER = 'A short welcome text, nothing else.';
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'mcp', tool: 'request_get', arguments: {} },
              { do: 'mcp', tool: 'request_ask', arguments: { question: QUESTION } },
            ],
          },
          {
            steps: [
              {
                do: 'mcp',
                tool: 'plan_propose',
                arguments: {
                  summary: 'A website with a home page and a contact form, in one ticket.',
                  new_project: newProject,
                  tickets: [setup, { ...contact, title: 'Home page and contact form' }],
                },
              },
            ],
          },
        ],
      });
      expect(await tick()).toEqual(['plan Request 1']);
      const first = await latestRun();
      expect(first).toMatchObject({ purpose: 'plan', projectId: null });
      await until('the question waiting', async () => {
        const current = await request(1);
        return current.status === 'planning' && current.run?.status === 'waiting_human';
      });
      expect((await request(1)).comments.at(-1)).toMatchObject({
        author: 'agent',
        kind: 'question',
        body: QUESTION,
      });
      expect((await needsYou()).map((item) => item.type)).toContain('request_question');

      // A new project's planning run: an empty scratch folder with no repository, the browsers
      // folder in its environment (lot 5 steps B2 and C1).
      const scratch = await sessionOf(first.id);
      expect(scratch.env.PLAYWRIGHT_BROWSERS_PATH).toBe(home.paths.browsers);
      expect(existsSync(join(scratch.cwd, '.git'))).toBe(false);

      // The owner's answer reaches the waiting session live (owner's answer 4): the plan.
      await owner('1/answer', { body: ANSWER });
      await until('the first plan proposed', async () => {
        return (await request(1)).status === 'plan_proposed' && (await endedSucceeded(first.id));
      });
      const answered = (await messages()).at(-1) ?? '';
      expect(answered).toContain('The owner answered your question about the request.');
      expect(answered).toContain(ANSWER);
      const firstPlan = (await request(1)).plan;
      if (!firstPlan) throw new Error('no first plan');

      // Rejected with feedback: a new planning run by itself, reading the feedback.
      const FEEDBACK = 'Put the contact form in a ticket of its own, after the setup.';
      expect(
        (await owner('1/plan/reject', { planId: firstPlan.id, feedback: FEEDBACK })).status,
      ).toBe('open');
      await fake.play({
        turns: [
          {
            steps: [
              {
                do: 'mcp',
                tool: 'plan_propose',
                arguments: {
                  summary: 'A website set up first, then its contact form.',
                  new_project: newProject,
                  tickets: [setup, contact],
                },
              },
            ],
          },
        ],
      });
      expect(await tick()).toEqual(['plan Request 1']);
      const second = await latestRun();
      await until('the second plan proposed', async () => {
        return (await request(1)).status === 'plan_proposed' && (await endedSucceeded(second.id));
      });
      expect((await messages()).at(-1)).toContain(FEEDBACK);
      const proposed = await request(1);
      if (!proposed.plan) throw new Error('no second plan');
      expect(proposed.earlierPlans).toMatchObject([
        { id: firstPlan.id, status: 'superseded', ownerFeedback: FEEDBACK },
      ]);
      expect(proposed.plan.tickets.map((each) => each.key)).toEqual(['setup', 'contact']);

      // Approved with the form (step M, item 7): the project, its private repository with the
      // skeleton, and the plan's tickets in To do, the feature waiting for the bootstrap.
      const approved = await owner('1/plan/approve', {
        planId: proposed.plan.id,
        project: {
          name: 'Contact form check',
          key: 'CNT',
          repositoryName: 'contact-form-check',
          private: true,
        },
      });
      expect(approved).toMatchObject({
        status: 'closed',
        project: { key: 'CNT', name: 'Contact form check' },
      });
      await until('the project ready', async () => (await project('CNT')).setup.status === 'ready');
      expect(await project('CNT')).toMatchObject({
        kind: 'website',
        repository: { owner: 'octo-owner', name: 'contact-form-check', private: true },
        requiredCapabilities: ['browser-tests'],
        mergesAutomatic: false,
      });
      // GitHub Actions runs the skeleton's CI on each pull request; the fake models workflows
      // apart from the files, so the created repository is given it, passing at once.
      Object.assign(contactRepository(), { workflows: [skeletonWorkflow()], ci: 'success' });
      expect(Object.keys(repositoryFiles(contactRepository()))).toEqual(
        expect.arrayContaining(['CLAUDE.md', '.github/workflows/ci.yml', 'docs/user/index.md']),
      );
      expect(await ticketOf('CNT', 1)).toMatchObject({
        title: 'Set up the website',
        status: 'todo',
        assignee: { key: 'architect' },
      });
      expect(await ticketOf('CNT', 2)).toMatchObject({ title: 'Contact form', status: 'todo' });
      expect((await queue()).candidates).toMatchObject([
        { kind: 'implement', ticket: { projectKey: 'CNT', number: 1 }, blocks: 1, reason: null },
        {
          kind: 'implement',
          ticket: { projectKey: 'CNT', number: 2 },
          reason: { reason: 'blocked', tickets: ['CNT-1'] },
        },
      ]);

      // The bootstrap, changing the skeleton's CI, then the feature once it is merged.
      const bootstrap = await implementedReviewedMerged('CNT', 1, [
        commit('index.astro', 'Set up the website'),
        {
          do: 'bash',
          command:
            "printf '%s\\n' '# The website job runs the tests.' >> .github/workflows/ci.yml && git commit -q -am 'Run the website tests in CI'",
        },
      ]);
      expect((await sessionOf(bootstrap)).env.PLAYWRIGHT_BROWSERS_PATH).toBe(home.paths.browsers);
      expect(repositoryFiles(contactRepository())['.github/workflows/ci.yml']).toContain(
        '# The website job runs the tests.',
      );
      await implementedReviewedMerged('CNT', 2, [commit('contact.astro', 'Add the contact form')]);
      expect(repositoryFiles(contactRepository())['contact.astro']).toBe('Add the contact form\n');

      // Done: nothing waits; every run started by the scheduler succeeded, in this order.
      expect(await queue()).toMatchObject({ candidates: [] });
      expect(await tick()).toEqual([]);
      const runs = (await h.t.db.select().from(schema.runs)).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const tickets = new Map(
        (await h.t.db.select().from(schema.tickets)).map((row) => [
          row.id,
          `CNT-${String(row.number)}`,
        ]),
      );
      const requests = new Map(
        (await h.t.db.select().from(schema.requests)).map((row) => [
          row.id,
          `Request ${String(row.number)}`,
        ]),
      );
      expect(
        runs.map(
          (row) =>
            `${row.purpose} ${tickets.get(row.ticketId ?? '') ?? requests.get(row.requestId ?? '') ?? '?'}`,
        ),
      ).toEqual([
        'plan Request 1',
        'plan Request 1',
        'implement CNT-1',
        'review CNT-1',
        'implement CNT-2',
        'review CNT-2',
      ]);
      for (const row of runs) expect(row.status).toBe('succeeded');
      // Sessions (step L's estimate): each planning run one, the answer taken live, then each
      // ticket's implement and review.
      expect(await sessions()).toBe(6);
    },
    TIMEOUT,
  );

  it(
    "K2: a request on an existing project planned in a worktree detached at GitHub's head of the base branch, approved, its tickets in To do; a second request closed while planning",
    async () => {
      const machineId = await enrol();
      await started(machineId);
      // Someone's commit on GitHub's main since the project was linked.
      const head = h.github.commit(bakery(), 'main', { 'NEWS.md': 'Open on Sundays.\n' }, 'News');

      const created = await h.call('POST', '/api/requests', {
        body: 'Add an opening hours page linked from the home page.',
        project: 'WEB',
      });
      expect(created.statusCode, created.body).toBe(201);
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'mcp', tool: 'request_get', arguments: {} },
              { do: 'bash', command: 'git status' },
              { do: 'bash', command: 'git log -1 --format=%H' },
              {
                do: 'mcp',
                tool: 'plan_propose',
                arguments: {
                  summary: 'An opening hours page, then its link from the home page.',
                  tickets: [
                    {
                      key: 'hours',
                      type: 'feature',
                      title: 'Opening hours page',
                      acceptance_criteria: ['The page lists the hours of each day'],
                      assignee: 'web_dev',
                    },
                    {
                      key: 'link',
                      type: 'feature',
                      title: 'Link the opening hours from the home page',
                      acceptance_criteria: ['The home page links to the opening hours'],
                      assignee: 'web_dev',
                      blocked_by: ['hours'],
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      expect(await tick()).toEqual(['plan Request 1']);
      const planning = await latestRun();
      expect(planning).toMatchObject({ purpose: 'plan', branchName: null });
      await until('the plan proposed', async () => {
        return (await request(1)).status === 'plan_proposed' && (await endedSucceeded(planning.id));
      });

      // The planning worktree: detached at GitHub's head of main, with no branch of its own.
      const bash = (await fake.log()).flatMap((entry) => (entry.event === 'bash' ? [entry] : []));
      expect(bash.map((entry) => [entry.command, entry.exitCode])).toEqual([
        ['git status', 0],
        ['git log -1 --format=%H', 0],
      ]);
      expect(bash[0]?.output).toContain('Not currently on any branch.');
      expect(bash[1]?.output.trim()).toBe(head);
      expect([...h.github.branches(bakery()).keys()]).toEqual(['main']);
      // The plan's tickets are on the plan only until the approval (owner's answer 9, step E1).
      expect(await h.t.db.select().from(schema.tickets)).toEqual([]);

      const plan = (await request(1)).plan;
      if (!plan) throw new Error('no plan');
      expect(await owner('1/plan/approve', { planId: plan.id })).toMatchObject({
        status: 'closed',
        plan: {
          status: 'approved',
          tickets: [
            { key: 'hours', created: { reference: 'WEB-1' } },
            { key: 'link', created: { reference: 'WEB-2' } },
          ],
        },
      });
      expect(await ticketOf('WEB', 1)).toMatchObject({
        status: 'todo',
        assignee: { key: 'web_dev' },
      });
      expect(await ticketOf('WEB', 2)).toMatchObject({
        status: 'todo',
        blockedBy: [{ number: 1 }],
      });

      // A second request; Close request while its planning run works (owner's answer 5).
      const blog = await h.call('POST', '/api/requests', { body: 'A blog.', project: 'WEB' });
      expect(blog.statusCode, blog.body).toBe(201);
      await fake.play({
        turns: [{ steps: [{ do: 'mcp', tool: 'request_get', arguments: {} }, { do: 'hang' }] }],
      });
      expect(await tick()).toEqual(['plan Request 2']);
      const closing = await latestRun();
      await until('the planning run working', async () => (await run(closing.id)).sessionAlive);
      expect(await owner('2/close')).toMatchObject({ status: 'closed', run: null, stopped: null });
      await until('its session closed', async () => {
        const current = await run(closing.id);
        return current.status === 'cancelled' && !current.sessionAlive;
      });
      expect(sessionAlive(closing.id)).toBe(false);
      // Nothing added to the project, nothing more to plan.
      const tickets = await h.t.db
        .select({ number: schema.tickets.number })
        .from(schema.tickets)
        .orderBy(asc(schema.tickets.number));
      expect(tickets).toEqual([{ number: 1 }, { number: 2 }]);
      expect((await queue()).candidates.map((candidate) => candidate.kind)).toEqual([
        'implement',
        'implement',
      ]);
      expect(await sessions()).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'K3: a machine whose daemon speaks protocol 2 takes no run; the same machine with the protocol 3 daemon takes the planning run and the implement run',
    async () => {
      // An account running two at a time (owner's answer 7), its machine enrolled; a 0.5.0
      // daemon connects with that machine's token (owner's answer 1).
      const machineId = await enrol(2);
      const config = JSON.parse(readFileSync(home.paths.config, 'utf8')) as {
        machineToken: string;
      };
      const old = await h.connect(config.machineToken, {
        protocolVersion: 2,
        daemonVersion: '0.5.0',
      });
      await h.createTicket();
      const created = await h.call('POST', '/api/requests', {
        body: 'A contact form on the home page.',
        project: 'WEB',
      });
      expect(created.statusCode, created.body).toBe(201);

      // The queue: both wait, "Update the daemon to <this server's version>" (owner's answer 3).
      const version = (await h.call('GET', '/version')).json<{ server: string }>().server;
      const outdated = {
        reason: 'no_machine',
        machines: [
          {
            machine: { id: machineId, name: 'Laptop' },
            unavailable: {
              why: 'unusable',
              reasons: [
                {
                  type: 'daemon_outdated',
                  daemonVersion: '0.5.0',
                  protocolVersion: 2,
                  serverVersion: version,
                  serverProtocolVersion: PROTOCOL_VERSION,
                },
              ],
            },
          },
        ],
      };
      expect((await queue()).candidates).toMatchObject([
        { kind: 'plan', request: { number: 1 }, reason: outdated },
        { kind: 'implement', ticket: { number: 1 }, reason: outdated },
      ]);
      for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
      expect(old.received.filter((message) => message.type === 'run.start')).toEqual([]);
      expect((await needsYou()).map((item) => item.type)).toContain('daemon_outdated');

      // The owner updates the daemon: the 0.5.0 one stops, the protocol 3 one starts.
      await old.close();
      await until('the machine offline', async () => !(await machine(machineId)).online);
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the work.' }] }] });
      await started(machineId);
      expect((await needsYou()).map((item) => item.type)).not.toContain('daemon_outdated');
      expect(await tick()).toEqual(['plan Request 1', 'implement WEB-1']);
      const runs = await h.t.db.select().from(schema.runs);
      expect(runs.map((row) => row.purpose).sort()).toEqual(['implement', 'plan']);
      for (const row of runs) {
        await until(`the ${row.purpose} run running`, async () => {
          const current = await run(row.id);
          return current.status === 'running' && current.machine.id === machineId;
        });
      }
      expect(await sessions()).toBe(2);

      // Stopped by the owner, so the test ends with both sessions closed.
      for (const row of runs) {
        const stopped = await h.call('POST', `/api/runs/${row.id}/stop`);
        expect(stopped.statusCode, stopped.body).toBe(200);
        await until('the session closed', async () => !(await run(row.id)).sessionAlive);
      }
      const [planning] = await h.t.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.purpose, 'plan'));
      expect(planning?.status).toBe('cancelled');
    },
    TIMEOUT,
  );
});
