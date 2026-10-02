import { describe, expect, it } from 'vitest';
import { helpPages } from './content';
import { buildPages, helpHref, isExternal, plainText, searchPages } from './pages';

const files = {
  '/docs/user/index.md':
    '# Help\n\n- [Start](getting-started.md)\n- [Token](github-token.md#create)\n',
  '/docs/user/zebra.md': '# A page nobody links\n\nText.',
  '/docs/user/github-token.md': '# Connect GitHub\n\nPaste the **token** in `Settings`.',
  '/docs/user/getting-started.md':
    '# Getting started\n\n| Step | What |\n|---|---|\n| 1 | Create the [account](index.md) |\n',
};

describe('buildPages', () => {
  it('takes titles from the first heading and orders pages like the index links them', () => {
    const pages = buildPages(files);
    expect(pages.map((page) => [page.slug, page.title])).toEqual([
      ['index', 'Help'],
      ['getting-started', 'Getting started'],
      ['github-token', 'Connect GitHub'],
      ['zebra', 'A page nobody links'],
    ]);
  });
});

describe('plainText', () => {
  it('keeps the words of links, tables and emphasis', () => {
    expect(plainText(files['/docs/user/getting-started.md'])).toBe(
      'Getting started Step What 1 Create the account',
    );
  });
});

describe('helpHref', () => {
  it('turns links to other pages into Help addresses', () => {
    expect(helpHref('reset-password.md')).toBe('/help/reset-password');
    expect(helpHref('github-token.md#create-the-token')).toBe(
      '/help/github-token#create-the-token',
    );
    expect(helpHref('index.md')).toBe('/help');
  });

  it('leaves other links alone', () => {
    expect(helpHref('https://github.com/settings')).toBe('https://github.com/settings');
    expect(helpHref('#steps')).toBe('#steps');
    expect(isExternal('https://github.com')).toBe(true);
    expect(isExternal('/help/x')).toBe(false);
  });
});

describe('searchPages', () => {
  const pages = buildPages(files);

  it('finds pages containing every word, with an extract', () => {
    expect(searchPages(pages, 'paste')).toEqual([
      {
        slug: 'github-token',
        title: 'Connect GitHub',
        snippet: 'Connect GitHub Paste the token in Settings .',
      },
    ]);
    expect(searchPages(pages, 'TOKEN settings').map((result) => result.slug)).toEqual([
      'github-token',
    ]);
    expect(searchPages(pages, 'token nowhere')).toEqual([]);
    expect(searchPages(pages, '   ')).toEqual([]);
  });

  it('lists the pages matching in their title first', () => {
    expect(searchPages(pages, 'start').map((result) => result.slug)).toEqual([
      'getting-started',
      'index',
    ]);
  });
});

describe('the user documentation', () => {
  it('starts with the index and has a title on every page', () => {
    expect(helpPages[0]?.slug).toBe('index');
    for (const page of helpPages) expect(page.title).not.toBe(page.slug);
  });

  it('links every page from the index, so the Help navigation follows it', () => {
    const index = helpPages[0]?.markdown ?? '';
    for (const page of helpPages.slice(1)) expect(index).toContain(`(${page.slug}.md`);
  });

  // Owner's check, lot 2 step N: the owner missed the small ticket, and pasted both criteria as one.
  it('points from Add a machine to the small ticket, whose criteria are given one per line', () => {
    const page = (slug: string) => helpPages.find((each) => each.slug === slug)?.markdown ?? '';
    const addMachine = /## Add a machine\n([\s\S]*?)\n### /.exec(page('machines'))?.[1] ?? '';
    expect(addMachine).toContain('(runs.md#try-it-with-a-small-ticket)');
    expect(page('runs')).toMatch(
      /\n {2}1\. `README\.md ends with the line given in the answer`\n {2}2\. `A ticket "Add a CONTRIBUTING\.md file" was proposed`\n/,
    );
  });
});
