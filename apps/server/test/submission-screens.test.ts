import { schema } from '@orchestrator/db';
import { HIDDEN, type DodReport } from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { RunHarness, cleanWorkspace, eventually } from './run-harness.js';

// What the ticket page and the run page receive of a submission (02, sections 6.4 and 7; lot 3
// step F4): each check's result with its reasons, the workflow flag with its reason, the pull
// request, and a run's latest refused submission; every stored text credentials masked.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
  await h.stop();
});

const SECRET = `github_pat_${'A1b2C3d4'.repeat(4)}`;

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

async function working() {
  await h.start();
  h.github.repository('octo-owner', 'bakery');
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  return { ...machine, ...run };
}

describe('the ticket page (02, section 6.4)', () => {
  it('shows the accepted checks, the workflow flag with its reason and the pull request once opened', async () => {
    const { daemon, runToken } = await working();
    const before = await h.ticket();
    expect(before).toMatchObject({
      dodChecks: null,
      workflowFlag: null,
      pullRequest: { opened: null, wanted: false, failure: null },
    });

    const listed = ['.github/workflows/ci.yml', 'docs/user/contact.md', 'src/contact.test.ts'];
    expect(
      await h.tool(
        daemon,
        runToken,
        'ticket_submit',
        REPORT,
        cleanWorkspace({ changedFiles: { listed, count: 5 } }),
      ),
    ).toMatchObject({ ok: true });
    const ticket = await h.ticket();
    expect(ticket.workflowFlag).toBe('changed');
    expect(ticket.dodChecks?.map((each) => [each.check, each.result])).toEqual([
      ['criteria_met', 'passed'],
      ['worktree_clean', 'passed'],
      ['commits_ahead', 'passed'],
      ['pushed', 'passed'],
      ['type_rules', 'passed'],
      ['paths_changed', 'passed'],
    ]);

    await eventually('the pull request opened', async () => {
      expect((await h.ticket()).pullRequest).toEqual({
        opened: { number: 1, url: expect.stringMatching(/\/pull\/1$/) as string, state: 'open' },
        wanted: false,
        failure: null,
      });
    });
  });

  it('shows a pull request not opened, with its reason, while it is still wanted', async () => {
    const { daemon, runToken } = await working();
    h.github.override = (request) =>
      request.method === 'GET' && /\/pulls\?/.test(request.path) ? { status: 502 } : undefined;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await eventually('the failure', async () => {
      expect((await h.ticket()).pullRequest).toMatchObject({
        opened: null,
        wanted: true,
        failure: { reason: 'unreachable' },
      });
    });
  });

  it('names a flag kept before its reason, and a list cut as not listed', async () => {
    const { daemon, runToken } = await working();
    expect(
      await h.tool(
        daemon,
        runToken,
        'ticket_submit',
        REPORT,
        cleanWorkspace({ changedFiles: { listed: ['src/contact.ts'], count: 40 } }),
      ),
    ).toMatchObject({ ok: true });
    const ticket = await h.ticket();
    expect(ticket.workflowFlag).toBe('not_listed');
    expect(ticket.dodChecks?.find((each) => each.check === 'paths_changed')).toMatchObject({
      result: 'incomplete',
      reasons: [{ kind: 'files_cut', listed: 1, count: 40, unchecked: 2 }],
    });
    await h.t.db.update(schema.tickets).set({ workflowReason: null });
    expect((await h.ticket()).workflowFlag).toBe('not_kept');
  });

  it("masks credentials in the agent's report", async () => {
    const { daemon, runToken } = await working();
    await h.ok(daemon, runToken, 'ticket_submit', {
      ...REPORT,
      summary: `Uses ${SECRET} to log in.`,
      criteria: [
        { index: 0, status: 'met', justification: `Token ${SECRET}` },
        { index: 1, status: 'met', justification: 'Tested' },
      ],
    });
    const ticket = await h.ticket();
    expect(JSON.stringify(ticket)).not.toContain(SECRET);
    expect(ticket.dodReport?.summary).toBe(`Uses ${HIDDEN} to log in.`);
    expect(ticket.dodReport?.criteria[0]?.justification).toBe(`Token ${HIDDEN}`);
  });
});

describe('the run page (02, section 7)', () => {
  it("shows the latest refused submission with each check's reasons, credentials masked", async () => {
    const { daemon, runId, runToken } = await working();
    expect((await h.run(runId)).refusedSubmission).toBeNull();
    const path = `docs/${SECRET}.md`;
    await h.tool(daemon, runToken, 'ticket_submit', {
      ...REPORT,
      docs: { paths: [path], justification: null },
    });
    const run = await h.run(runId);
    expect(JSON.stringify(run)).not.toContain(SECRET);
    const paths = run.refusedSubmission?.checks.find((each) => each.check === 'paths_changed');
    expect(paths).toMatchObject({
      result: 'failed',
      reasons: [{ kind: 'path_not_changed', list: 'docs', path: `docs/${HIDDEN}.md` }],
    });
    expect(paths?.messages[0]).toContain(`"docs/${HIDDEN}.md"`);
    expect(run.refusedSubmission?.report.docs.paths).toEqual([`docs/${HIDDEN}.md`]);
  });
});
