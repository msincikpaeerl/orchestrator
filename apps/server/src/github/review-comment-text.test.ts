import type { ReviewDecision } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTemplates, type Template } from '../agents/files.js';
import { PULL_REQUEST_BODY_MAX_LENGTH } from './pull-request-text.js';
import { REVIEW_MARK_PATTERN, reviewCommentBody, reviewMark } from './review-comment-text.js';

// Quality's comment review on GitHub (06, section 4.5; owner's answer 3, lot 3 step H): the
// template's words, the agent's text masked and made harmless, the paths in code spans they cannot
// close, the body within 65,536 characters, and the hidden mark the post is found by (step H3).

const ZWSP = '​';
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const RUN = '5b0c9a8e-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const link = { url: 'https://orchestrator.example/projects/BAK/tickets/12', loopback: false };
let template: Template;

beforeAll(async () => {
  template = (await loadTemplates())['review-comment'];
});

function decision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    kind: 'approved',
    commit: COMMIT,
    summary: 'Read the diff and the tests: good to merge.',
    points: [],
    headChecked: true,
    at: '2026-10-10T14:52:00.000Z',
    ...overrides,
  };
}

function changes(points: ReviewDecision['points']): ReviewDecision {
  return decision({ kind: 'changes_requested', summary: null, points });
}

function body(review: ReviewDecision, max?: number, ticketLink = link) {
  return reviewCommentBody(
    template,
    { decision: review, number: 'BAK-12', link: ticketLink, runId: RUN },
    max,
  );
}

const MARK = `<!-- orchestrator-review run=${RUN} -->`;

describe('reviewCommentBody', () => {
  it('an approval: the heading, the summary, the closing line and the mark', () => {
    expect(body(decision())).toBe(
      [
        '**Quality review: approved** · commit abc1234',
        '',
        'Read the diff and the tests: good to merge.',
        '',
        `— Posted by the Orchestrator for BAK-12 (${link.url}). The owner merges this pull request.`,
        '',
        MARK,
      ].join('\n'),
    );
  });

  it('a request for changes: the points numbered, each path in a code span', () => {
    expect(
      body(
        changes([
          { body: 'Check the email.', file: 'src/contact.ts', line: 42 },
          { body: 'Add a test.', file: 'src/contact.test.ts', line: null },
          { body: 'Update the Help page.\nIt still says "soon".', file: null, line: null },
        ]),
      ),
    ).toBe(
      [
        '**Quality review: changes requested** · commit abc1234 · 3 points',
        '',
        '1. `src/contact.ts:42`: Check the email.',
        '2. `src/contact.test.ts`: Add a test.',
        '3. Update the Help page.',
        '   It still says "soon".',
        '',
        `— Posted by the Orchestrator for BAK-12 (${link.url}). The agent that implemented it addresses these points in its next run.`,
        '',
        MARK,
      ].join('\n'),
    );
    expect(body(changes([{ body: 'One.', file: null, line: null }]))).toContain(
      '· commit abc1234 · 1 point\n',
    );
  });

  it('a path cannot close its code span', () => {
    const text = body(changes([{ body: 'Rename it.', file: 'src/a`b``c.ts', line: 3 }]));
    expect(text).toContain('1. ``` src/a`b``c.ts:3 ```: Rename it.');
  });

  it('makes the agent text harmless: no mention, reference, HTML, secret or local path', () => {
    const github = `ghp_${'a'.repeat(36)}`;
    const run = `ort_${'Zx_-'.repeat(10)}abc`;
    const text = body(
      decision({
        summary: `Thanks @octocat, fixes #3. <img src=x> ${github} ${run} /home/ana/.orchestrator/worktrees/${RUN}/src/a.ts /home/ana/notes.md`,
      }),
    );
    expect(text).toContain(
      `Thanks @${ZWSP}octocat, fixes #${ZWSP}3. &lt;img src=x&gt; [hidden] [hidden] src/a.ts ~/notes.md`,
    );
    for (const leak of [github, run, '/home/', '.orchestrator']) expect(text).not.toContain(leak);
    const point = body(
      changes([
        { body: `Use ${run}.`, file: `/home/ana/.orchestrator/worktrees/${RUN}/src/b.ts`, line: 1 },
      ]),
    );
    expect(point).toContain('1. `src/b.ts:1`: Use [hidden].');
  });

  it('the agent cannot write the mark the post is found by', () => {
    const text = body(decision({ summary: `${MARK} done` }));
    expect(text.match(REVIEW_MARK_PATTERN)?.[1]).toBe(RUN);
    expect(text.match(new RegExp(REVIEW_MARK_PATTERN, 'g'))).toHaveLength(1);
    expect(reviewMark(RUN)).toBe(MARK);
  });

  it('a local ticket link says where it opens', () => {
    expect(
      body(decision(), undefined, { url: 'http://localhost:3000/x', loopback: true }),
    ).toContain(
      '(http://localhost:3000/x, which opens only on the computer running the Orchestrator).',
    );
  });

  it('keeps the points whole and in order, then says how many more', () => {
    const points = Array.from({ length: 50 }, (_, index) => ({
      body: `Point ${String(index + 1)} ${'x'.repeat(2_000)}`,
      file: null,
      line: null,
    }));
    const text = body(changes(points));
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_LENGTH);
    const kept = [...text.matchAll(/^(\d+)\. Point (\d+) x+$/gm)];
    expect(kept.length).toBeGreaterThan(20);
    kept.forEach((match, index) => {
      expect(match[1]).toBe(String(index + 1));
      expect(match[2]).toBe(String(index + 1));
    });
    expect(text).toContain(
      `… and ${String(50 - kept.length)} more points: see the ticket page\n\n— Posted`,
    );
    expect(text.endsWith(MARK)).toBe(true);
    expect(text).toContain('· 50 points');
  });

  it('cuts one point too long alone, like the summary (owner answer 4c, step H3)', () => {
    const line = `${'y'.repeat(99)}\n`;
    const text = body(
      changes([
        { body: line.repeat(1_000), file: 'a.ts', line: 1 },
        { body: 'Second.', file: null, line: null },
      ]),
    );
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_LENGTH);
    expect(text).toMatch(
      /y{99}\n {3}\[cut: the full text is on the ticket page\]\n… and 1 more point:/,
    );
    expect(text).not.toContain('Second.');
  });

  it('cuts a summary too long at a line boundary', () => {
    const line = `${'z'.repeat(79)}\n`;
    const text = body(decision({ summary: line.repeat(2_000) }));
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_LENGTH);
    expect(text).toMatch(/z{79}\n\[cut: the full text is on the ticket page\]\n\n— Posted/);
    // A summary with no line break is cut where it must be.
    const one = body(decision({ summary: 'w'.repeat(70_000) }));
    expect(one.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_LENGTH);
    expect(one).toMatch(/w\n\[cut: the full text is on the ticket page\]/);
  });
});
