import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { findPage } from '../help/content';
import { harnessElement } from './text';

/** The help sections the project screens link to, as `page#section`. */
const linked = [
  'projects#branch-protection',
  'projects#if-the-setup-fails',
  ...Object.values(harnessElement).map((element) => element.help),
];

/** Heading ids of a Help page, rendered the way the Help section renders it. */
function anchors(slug: string): string[] {
  const page = findPage(slug);
  if (!page) return [];
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] },
      page.markdown,
    ),
  );
  return [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('help links of the project screens', () => {
  it.each(linked)('%s exists', (link) => {
    const [slug = '', section = ''] = link.split('#');
    expect(anchors(slug)).toContain(section);
  });
});
