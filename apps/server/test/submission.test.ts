import { schema } from '@orchestrator/db';
import {
  DodCheckResult,
  NeedsYouResponse,
  SubmissionRecord,
  type DodReport,
  type McpError,
  type McpResult,
  type PushResult,
  type RunStart,
  type RunState,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEAD, RunHarness, TOKEN, cleanWorkspace, state } from './run-harness.js';

/** A string matching `pattern`, inside an expected value (`stringMatching` is untyped). */
const matching = (pattern: RegExp) => expect.stringMatching(pattern) as string;

// `ticket_submit`'s checks with a scripted daemon (04, sections 3.1 and 3.3; 06, section 4.2;
// lot 3 step F2): what the agent is told, and what the run and the ticket keep.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

function refusal(result: McpResult['payload']): McpError {
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.output)}`);
  return result.error;
}

/** A ready project, `WEB-1` (a feature unless said) for the Web Developer, its run `running`. */
async function working(ticket: object = {}) {
  await h.start();
  await h.createTicket(ticket);
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  return { ...machine, ...run };
}

const REPORT: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'ContactForm renders the form' },
    { index: 1, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

async function runRow(id: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (!row) throw new Error('no run');
  return row;
}

async function ticketRow() {
  const [row] = await h.t.db.select().from(schema.tickets);
  if (!row) throw new Error('no ticket');
  return row;
}

const results = (checks: unknown) =>
  Object.fromEntries(
    z
      .array(DodCheckResult)
      .parse(checks)
      .map((each) => [each.check, each.result]),
  );

describe("ticket_submit's checks (04, section 3.1)", () => {
  it('lists each failed check and keeps the latest refusal; the accepted one is kept with its checks', async () => {
    const { daemon, runId, runToken } = await working();
    const failed = refusal(
      await h.tool(
        daemon,
        runToken,
        'ticket_submit',
        { ...REPORT, criteria: [{ index: 0, status: 'not_met', justification: 'Not yet' }] },
        cleanWorkspace({ clean: false, commitsAhead: [], push: null }),
      ),
    );
    expect(failed.code).toBe('DOD_FAILED');
    expect(failed.message).toBe(
      'The submission is refused: 4 checks failed. Fix them and submit again.',
    );
    expect(failed.details?.map((detail) => detail.check)).toEqual([
      'criteria_met',
      'criteria_met',
      'worktree_clean',
      'commits_ahead',
    ]);
    // Criterion numbers from 1, as the owner reads them, with the tool's index (lot 4 step B).
    expect(failed.details?.slice(0, 2).map((detail) => detail.message)).toEqual([
      'Criterion 1 (index 0) is reported not_met: "The contact page has a form". Meet it, or use ticket_ask to get a decision.',
      'Criterion 2 (index 1) is not reported: "The e-mail address is checked".',
    ]);
    // Criteria the ticket does not have: the input is wrong, nothing is kept.
    expect(
      refusal(
        await h.tool(daemon, runToken, 'ticket_submit', {
          ...REPORT,
          criteria: [{ index: 5, status: 'met', justification: 'Done' }],
        }),
      ),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      message:
        'The ticket has 2 acceptance criteria, criteria 1 to 2 (indexes 0 to 1): your report names criterion 6 (index 5), which the ticket does not have.',
      details: [{ field: 'criteria.0.index', message: 'no criterion 6 (index 5)' }],
    });

    // The run keeps its latest refused submission, with each check's result.
    const kept = SubmissionRecord.parse((await runRow(runId)).refusedSubmission);
    expect(kept.report.criteria[0]?.status).toBe('not_met');
    expect(results(kept.checks)).toEqual({
      criteria_met: 'failed',
      worktree_clean: 'failed',
      commits_ahead: 'failed',
      pushed: 'skipped',
      type_rules: 'passed',
      paths_changed: 'passed',
    });
    const [refusedEvent] = await h.events('ticket.submission_refused');
    expect(refusedEvent).toMatchObject({
      actor: 'agent',
      payload: { failed: ['criteria_met', 'worktree_clean', 'commits_ahead'], runId },
    });

    const accepted = await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    // The run waits for CI from step G1a (04, section 3.1).
    expect(accepted).toMatchObject({ result: 'pending_ci', ticket: { status: 'in_progress' } });
    const run = await runRow(runId);
    // The refusal before it is kept beside the accepted submission.
    expect(SubmissionRecord.parse(run.refusedSubmission).report.criteria[0]?.status).toBe(
      'not_met',
    );
    const submission = SubmissionRecord.parse(run.submission);
    expect(submission.report).toEqual(REPORT);
    expect(Object.values(results(submission.checks))).toEqual(Array(6).fill('passed'));
    const ticket = await ticketRow();
    expect(results(ticket.dodChecks)).toEqual(results(submission.checks));
    expect(ticket).toMatchObject({ workflowChanges: false, workflowReason: null });
    const [event] = await h.events('ticket.submitted');
    expect(event).toMatchObject({ payload: { criteria: 2, workflowChanges: false } });

    await h.ciPasses(daemon, runId);
    expect((await h.run(runId)).status).toBe('succeeded');
    expect((await h.ticket()).status).toBe('in_review');
  });

  it('refuses listed paths outside the repository, folders and files the branch did not change', async () => {
    const { daemon, runId, runToken } = await working();
    const failed = refusal(
      await h.tool(daemon, runToken, 'ticket_submit', {
        ...REPORT,
        tests: {
          paths: ['../../etc/passwd', 'src', './src//contact.test.ts'],
          justification: null,
        },
        docs: { paths: ['docs/user/other.md'], justification: null },
        adrs: ['/docs/adr/0001-x.md'],
      }),
    );
    expect(failed.details).toEqual([
      {
        check: 'paths_changed',
        message: matching(/^tests.paths: "..\/..\/etc\/passwd" is outside the repository/),
      },
      {
        check: 'paths_changed',
        message: matching(/^tests.paths: "src" is a folder.*a folder is not accepted/),
      },
      {
        check: 'paths_changed',
        message: matching(/^docs.paths: "docs\/user\/other.md" is not a file this branch changed/),
      },
      {
        check: 'paths_changed',
        message: matching(/^adrs: "\/docs\/adr\/0001-x.md" is outside the repository/),
      },
    ]);
    expect(
      results(SubmissionRecord.parse((await runRow(runId)).refusedSubmission).checks).paths_changed,
    ).toBe('failed');
  });

  it('accepts a submission whose paths a cut list leaves out, saying the check could not be fully done', async () => {
    const { daemon, runId, runToken } = await working();
    const cut = { listed: ['src/contact.ts'], count: 5000 };
    const result = await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      REPORT,
      cleanWorkspace({ changedFiles: cut }),
    );
    expect(result.ok).toBe(true);
    const submission = SubmissionRecord.parse((await runRow(runId)).submission);
    expect(submission.checks.find((each) => each.check === 'paths_changed')).toEqual({
      check: 'paths_changed',
      result: 'incomplete',
      messages: [
        'Could not be fully done: this machine listed 1 of the 5000 files the branch changed, so 2 listed paths could not be compared.',
      ],
      reasons: [{ kind: 'files_cut', listed: 1, count: 5000, unchecked: 2 }],
    });
    // A cut list may hide a workflow: flagged, the safe side, with its reason.
    expect(submission).toMatchObject({ workflowChanges: true, workflowReason: 'not_listed' });
    expect(await ticketRow()).toMatchObject({
      workflowChanges: true,
      workflowReason: 'not_listed',
    });
  });

  it('flags a branch that changes a workflow', async () => {
    const { daemon, runToken } = await working();
    const listed = ['.github/workflows/ci.yml', 'docs/user/contact.md', 'src/contact.test.ts'];
    await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      REPORT,
      cleanWorkspace({ changedFiles: { listed, count: 3 } }),
    );
    expect(await ticketRow()).toMatchObject({ workflowChanges: true, workflowReason: 'changed' });
    const [event] = await h.events('ticket.submitted');
    expect(event).toMatchObject({ payload: { workflowChanges: true } });
  });

  it('a docs ticket needs a documentation file the branch changed, wherever it is', async () => {
    const { daemon, runToken } = await working({ type: 'docs', title: 'Explain the contact form' });
    const noDocs = { ...REPORT, docs: { paths: [], justification: 'The README is enough.' } };
    expect(refusal(await h.tool(daemon, runToken, 'ticket_submit', noDocs)).details).toEqual([
      {
        check: 'type_rules',
        message: matching(/^A docs ticket's deliverable is its documentation/),
      },
    ]);
    const readme = {
      ...REPORT,
      tests: { paths: [], justification: 'Documentation only.' },
      docs: { paths: ['README.md'], justification: null },
    };
    const accepted = await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      readme,
      cleanWorkspace({ changedFiles: { listed: ['README.md'], count: 1 } }),
    );
    expect(accepted.ok).toBe(true);
  });

  it('a spike needs an ADR or a document', async () => {
    const { daemon, runToken } = await working({ type: 'spike', title: 'Which mail service' });
    const nothing = {
      ...REPORT,
      tests: { paths: [], justification: 'Research only.' },
      docs: { paths: [], justification: 'Findings in the comments.' },
    };
    expect(
      refusal(await h.tool(daemon, runToken, 'ticket_submit', nothing)).details?.map(
        (d) => d.check,
      ),
    ).toEqual(['type_rules']);
    const adr = { ...nothing, adrs: ['docs/adr/0002-mail-service.md'] };
    const accepted = await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      adr,
      cleanWorkspace({ changedFiles: { listed: ['docs/adr/0002-mail-service.md'], count: 1 } }),
    );
    expect(accepted.ok).toBe(true);
  });
});

// GitHub's own words for the two refusals the owner's smoke run met (lot 3 step E3, A3 and A2).
const NO_CONTENTS_WRITE =
  "Write access to repository not granted.\nfatal: unable to access 'https://github.com/octo-owner/bakery.git/': The requested URL returned error: 403";
const NO_WORKFLOWS_WRITE =
  'To https://github.com/octo-owner/bakery.git\n!\trefs/heads/t/1-contact-form:refs/heads/t/1-contact-form\t[remote rejected] (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nDone';

async function needsYou() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items.filter(
    (item) => item.type === 'push_failed',
  );
}

/** The run's end as the daemon reports it, with its end push. */
function ended(
  runId: string,
  reason: 'push_failed' | 'crashed',
  push: PushResult | null,
): RunState {
  const message = state(runId, { state: 'ended', reason });
  if (message.payload.state !== 'ended') throw new Error('not an end');
  return { ...message, payload: { ...message.payload, push } };
}

/** A submission whose push failed, answered, then the run's end at the turn's end. */
async function pushFailed(
  push: Extract<PushResult, { status: 'failed' }>,
  endPush: PushResult | null = null,
) {
  const run = await working();
  const answer = refusal(
    await h.tool(run.daemon, run.runToken, 'ticket_submit', REPORT, cleanWorkspace({ push })),
  );
  await h.report(run.daemon, ended(run.runId, 'push_failed', endPush));
  return { ...run, answer };
}

describe('push_failed (04, sections 3.1 and 5)', () => {
  it('tells the agent to end its turn; the run is not counted and Needs you names Contents', async () => {
    const {
      answer,
      runId,
      id: machineId,
    } = await pushFailed({
      status: 'failed',
      reason: 'refused',
      message: NO_CONTENTS_WRITE,
    });
    expect(answer).toEqual({
      code: 'DOD_FAILED',
      message: matching(
        /could not be pushed to GitHub\. This is not yours to fix.*end your turn now/,
      ),
      details: [
        { check: 'pushed', message: 'GitHub refused the push of the branch t/1-contact-form.' },
      ],
    });

    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'push_failed' });
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    const comment = ticket.timeline.findLast((entry) => entry.type === 'comment');
    expect(comment).toMatchObject({
      comment: {
        author: 'system',
        body: matching(
          /^The run on machine Laptop ended: its branch could not be pushed to GitHub, because GitHub refused it\. The token needs the permission Contents \(Read and write\)\. It does not count as a failed attempt\./,
        ),
      },
    });

    expect(await needsYou()).toEqual([
      {
        type: 'push_failed',
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        machine: { id: machineId, name: 'Laptop' },
        reason: 'refused',
        permission: 'contents',
        message: NO_CONTENTS_WRITE,
        since: run.endedAt,
      },
    ]);
  });

  it("names Workflows for GitHub's workflow refusal", async () => {
    await pushFailed({ status: 'failed', reason: 'refused', message: NO_WORKFLOWS_WRITE });
    expect(await needsYou()).toMatchObject([{ reason: 'refused', permission: 'workflows' }]);
    const comment = (await h.ticket()).timeline.findLast((entry) => entry.type === 'comment');
    expect(comment).toMatchObject({
      comment: { body: matching(/permission Workflows \(Read and write\)/) },
    });
  });

  it("gives any other refusal in GitHub's words, masked", async () => {
    await pushFailed({
      status: 'failed',
      reason: 'refused',
      message: `remote: Repository rule violations found\nhttps://x-access-token:${TOKEN}@github.com`,
    });
    const [item] = await needsYou();
    expect(item).toMatchObject({ reason: 'refused', permission: null });
    expect(item?.message).toContain('Repository rule violations found');
    expect(item?.message).not.toContain(TOKEN);
  });

  it('says when GitHub could not be reached', async () => {
    await pushFailed({
      status: 'failed',
      reason: 'unreachable',
      message: 'fatal: unable to access: Could not resolve host: github.com',
    });
    expect(await needsYou()).toMatchObject([{ reason: 'unreachable', permission: null }]);
  });

  it('the next run says the work was not pushed; the item stays while it works and goes at its push', async () => {
    const { daemon } = await pushFailed({
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    });
    const next = await h.running(daemon);
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === next.runId,
      'run.start',
    );
    expect(start.payload.initialPrompt).toMatch(
      /committed on this machine but not pushed to GitHub/,
    );
    expect(start.payload.initialPrompt).not.toMatch(/git merge origin\/t\/1-contact-form/);
    expect(await needsYou()).toHaveLength(1);
    expect((await h.tool(daemon, next.runToken, 'ticket_submit', REPORT)).ok).toBe(true);
    expect(await needsYou()).toEqual([]);
  });

  it('an end push done removes the item', async () => {
    await pushFailed(
      { status: 'failed', reason: 'unreachable', message: 'Could not resolve host: github.com' },
      { status: 'pushed', head: HEAD },
    );
    expect(await needsYou()).toEqual([]);
    const comment = (await h.ticket()).timeline.findLast((entry) => entry.type === 'comment');
    expect(comment).toMatchObject({
      comment: { body: matching(/the push at the run's end succeeded/) },
    });
  });

  it('a later end push that fails keeps the item; cancelling the ticket removes it', async () => {
    const { daemon } = await pushFailed({
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    });
    const next = await h.running(daemon);
    await h.report(
      daemon,
      ended(next.runId, 'crashed', {
        status: 'failed',
        reason: 'unreachable',
        message: 'Could not resolve host: github.com',
      }),
    );
    expect(await needsYou()).toHaveLength(1);
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await needsYou()).toEqual([]);
  });

  it('an item goes when its machine is revoked: the work there is lost', async () => {
    const { id } = await pushFailed({
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    });
    expect(await needsYou()).toHaveLength(1);
    const revoked = await h.call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await needsYou()).toEqual([]);
  });

  it("a diverged branch: the next run merges GitHub's branch first", async () => {
    const { daemon } = await pushFailed({
      status: 'failed',
      reason: 'diverged',
      message: '! [rejected] t/1-contact-form -> t/1-contact-form (fetch first)',
    });
    expect(await needsYou()).toMatchObject([{ reason: 'diverged', permission: null }]);
    const next = await h.running(daemon);
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === next.runId,
      'run.start',
    );
    expect(start.payload.initialPrompt).toMatch(
      /GitHub's copy of the branch has commits this machine does not have.*run `git merge origin\/t\/1-contact-form`/s,
    );
  });
});
