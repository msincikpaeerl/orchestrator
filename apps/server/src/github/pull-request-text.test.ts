import type { DodReport } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTemplates, type Template } from '../agents/files.js';
import {
  PULL_REQUEST_BODY_MAX_LENGTH,
  PULL_REQUEST_TITLE_MAX_LENGTH,
  harmless,
  pullRequestBody,
  pullRequestTitle,
  ticketLink,
} from './pull-request-text.js';

const ZWSP = '​';
let template: Template;

beforeAll(async () => {
  template = (await loadTemplates())['pull-request'];
});

const report: DodReport = {
  criteria: [
    { index: 1, status: 'met', justification: 'see Form.test.ts' },
    { index: 0, status: 'met', justification: 'the page shows it' },
  ],
  tests: { paths: ['src/Form.test.ts'], justification: null },
  docs: { paths: [], justification: 'no user-visible change' },
  adrs: [],
  summary: 'Adds a contact form.',
};

const link = { url: 'https://orchestrator.example/projects/WEB/tickets/12', loopback: false };

function body(overrides: Partial<Parameters<typeof pullRequestBody>[1]> = {}, max?: number) {
  return pullRequestBody(
    template,
    {
      number: 'WEB-12',
      criteria: ['The form shows', 'The email is checked'],
      report,
      workflowChanges: false,
      link,
      ...overrides,
    },
    max,
  );
}

describe('harmless', () => {
  it('masks secrets', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(harmless(`token ${token} here`)).toBe('token [hidden] here');
  });

  it('escapes HTML, code spans included (owner answer 4)', () => {
    expect(harmless('<img src=x onerror=alert(1)> & `Array<string>`')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &amp; `Array&lt;string&gt;`',
    );
    // A numeric entity cannot bring an @ or a # back.
    expect(harmless('&#64;octocat')).toBe(`&amp;#${ZWSP}64;octocat`);
  });

  it('stops mentions, issue references and closing keywords', () => {
    expect(harmless('thanks @octocat and @org/team')).toBe(
      `thanks @${ZWSP}octocat and @${ZWSP}org/team`,
    );
    expect(harmless('fixes #3, closes owner/repo#12, resolves GH-4 and gh-5')).toBe(
      `fixes #${ZWSP}3, closes owner/repo#${ZWSP}12, resolves GH-${ZWSP}4 and gh-${ZWSP}5`,
    );
    expect(harmless('fixes https://github.com/o/r/issues/7')).toBe(
      `fixes https://github.com/o/r/issues/${ZWSP}7`,
    );
    // Not a reference: left as written (owner's answer 5: no zero-width space in /pull/ links).
    expect(harmless('## Heading, #tag, a@ b, https://github.com/o/r/pull/7')).toBe(
      '## Heading, #tag, a@ b, https://github.com/o/r/pull/7',
    );
  });
});

describe('pullRequestTitle', () => {
  it('is <number>: <title>, made harmless', () => {
    expect(pullRequestTitle(template, { number: 'WEB-12', title: 'Fix #3 for @bob <b>' })).toBe(
      `WEB-12: Fix #${ZWSP}3 for @${ZWSP}bob &lt;b&gt;`,
    );
  });

  it('breaks a GH project key, which GitHub would read as an issue', () => {
    expect(pullRequestTitle(template, { number: 'GH-12', title: 'Docs' })).toBe(
      `GH-${ZWSP}12: Docs`,
    );
  });

  it('is cut at the limit, never inside a character', () => {
    const title = pullRequestTitle(template, { number: 'WEB-1', title: '😀'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(PULL_REQUEST_TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    const exact = pullRequestTitle(template, { number: 'WEB-1', title: 'a'.repeat(249) });
    expect(exact).toHaveLength(256);
    expect(exact.endsWith('a')).toBe(true);
  });
});

describe('pullRequestBody', () => {
  it('holds the summary, criteria in order, tests, documentation, ADRs and the link', () => {
    const text = body();
    expect(text).toContain('Adds a contact form.');
    expect(text).toContain(
      '- [x] The form shows: the page shows it\n- [x] The email is checked: see Form.test.ts',
    );
    expect(text).toContain('## Tests\n\n- `src/Form.test.ts`');
    expect(text).toContain('## Documentation\n\nNone: no user-visible change');
    expect(text).toContain('## Architecture decisions\n\nNone.');
    expect(text).not.toContain('.github/workflows/');
    expect(text.endsWith(`Ticket WEB-12 in the Orchestrator: ${link.url}`)).toBe(true);
  });

  it('warns of workflow changes', () => {
    expect(body({ workflowChanges: true })).toContain(
      'This branch changes files under `.github/workflows/`',
    );
  });

  it('says a loopback link opens only on the Orchestrator computer', () => {
    expect(
      body({ link: { url: 'http://localhost:3000/projects/WEB/tickets/12', loopback: true } }),
    ).toContain('(opens only on the computer running the Orchestrator)');
  });

  it("makes the ticket's and the agent's texts harmless", () => {
    const text = body({
      criteria: ['Mention @alice', 'Close #9'],
      report: {
        ...report,
        summary: `Fixes #1 <script>x</script> ghp_${'b'.repeat(36)}`,
        adrs: ['docs/adr/0001-@x.md'],
      },
    });
    expect(text).toContain(`Fixes #${ZWSP}1 &lt;script&gt;x&lt;/script&gt; [hidden]`);
    expect(text).toContain(`Mention @${ZWSP}alice`);
    expect(text).toContain(`Close #${ZWSP}9`);
    expect(text).toContain(`docs/adr/0001-@${ZWSP}x.md`);
    expect(text).not.toMatch(/<|@[a-z]|#\d/);
  });

  it('cuts the longest sections first, with a marker, keeping the warning and the link', () => {
    const long = 'x'.repeat(PULL_REQUEST_BODY_MAX_LENGTH);
    const text = body({
      workflowChanges: true,
      report: {
        ...report,
        summary: long,
        tests: { paths: ['a'.repeat(30_000)], justification: null },
      },
    });
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_LENGTH);
    expect(text.length).toBeGreaterThan(PULL_REQUEST_BODY_MAX_LENGTH - 100);
    expect(text).toContain('[… cut: the text was longer than a pull request description allows]');
    expect(text).toContain('.github/workflows/');
    expect(text.endsWith(link.url)).toBe(true);
    // The short sections are whole.
    expect(text).toContain('None: no user-visible change');
    expect(text).toContain('- [x] The form shows: the page shows it');
  });

  it('counts the escapes in the limit', () => {
    const text = body({ report: { ...report, summary: '<'.repeat(20_000) } }, 50_000);
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(text).toContain('[… cut');
  });

  it('is exactly at the limit uncut, and cut one character above', () => {
    const base = body({ report: { ...report, summary: '' } }).length;
    const fits = body({ report: { ...report, summary: 's'.repeat(1000) } }, base + 1000);
    expect(fits).toHaveLength(base + 1000);
    expect(fits).not.toContain('[… cut');
    const over = body({ report: { ...report, summary: 's'.repeat(1001) } }, base + 1000);
    expect(over.length).toBeLessThanOrEqual(base + 1000);
    expect(over).toContain('[… cut');
  });
});

describe('ticketLink', () => {
  it('joins PUBLIC_URL and the ticket page', () => {
    expect(ticketLink('https://o.example', 'WEB', 12)).toEqual({
      url: 'https://o.example/projects/WEB/tickets/12',
      loopback: false,
    });
    expect(ticketLink('https://o.example/base/', 'WEB', 3).url).toBe(
      'https://o.example/base/projects/WEB/tickets/3',
    );
  });

  it('knows loopback addresses', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(ticketLink(url, 'WEB', 1).loopback).toBe(true);
    }
    expect(ticketLink('http://192.168.1.2:3000', 'WEB', 1).loopback).toBe(false);
  });
});
