import { schema } from '@orchestrator/db';
import {
  DodCheckResult,
  SubmissionRecord,
  type DodReport,
  type McpError,
  type McpResult,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RunHarness, cleanWorkspace, state } from './run-harness.js';

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
      message: 'The ticket has 2 acceptance criteria (indexes 0 to 1): 5 do not exist.',
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
    expect(accepted).toMatchObject({ result: 'accepted', ticket: { status: 'in_progress' } });
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
    expect(ticket.workflowChanges).toBe(false);
    const [event] = await h.events('ticket.submitted');
    expect(event).toMatchObject({ payload: { criteria: 2, workflowChanges: false } });

    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
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
    });
    // A cut list may hide a workflow: flagged, the safe side.
    expect(submission.workflowChanges).toBe(true);
    expect((await ticketRow()).workflowChanges).toBe(true);
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
    expect((await ticketRow()).workflowChanges).toBe(true);
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
