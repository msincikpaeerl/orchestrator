/** One page of the user documentation (`docs/user/<slug>.md`), shown in the Help section. */
export interface HelpPage {
  slug: string;
  title: string;
  markdown: string;
  /** The page without Markdown syntax, for search. */
  text: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** The page's first `# ` heading, or its file name. */
function titleOf(slug: string, markdown: string): string {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? slug;
}

/** Removes the Markdown syntax that would get in the way of search and snippets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, '')
    .replace(MARKDOWN_LINK, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\|?[\s|:-]+\|?$/gm, '')
    .replace(/[*`|>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the Help pages from the Markdown files, keyed by path. Order: `index`, then the pages
 * in the order `index` first links to them, then the others by title.
 */
export function buildPages(files: Record<string, string>): HelpPage[] {
  const pages = Object.entries(files).map(([path, markdown]) => {
    const slug = (path.split('/').pop() ?? path).replace(/\.md$/, '');
    return { slug, title: titleOf(slug, markdown), markdown, text: plainText(markdown) };
  });
  const index = pages.find((page) => page.slug === 'index');
  const linked = index
    ? [...index.markdown.matchAll(MARKDOWN_LINK)].map((match) => helpSlug(match[2] ?? ''))
    : [];
  const rank = (page: HelpPage) => {
    if (page.slug === 'index') return -1;
    const position = linked.indexOf(page.slug);
    return position === -1 ? linked.length : position;
  };
  return pages.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** A relative link to another page of `docs/user/`: `other-page.md` or `other-page.md#part`. */
const PAGE_LINK = /^([\w-]+)\.md(#.*)?$/;

function helpSlug(href: string): string | null {
  return PAGE_LINK.exec(href)?.[1] ?? null;
}

/** Address in the application of a link found in a Help page; other links are unchanged. */
export function helpHref(href: string): string {
  const match = PAGE_LINK.exec(href);
  if (!match) return href;
  const [, slug, hash = ''] = match;
  return slug === 'index' ? `/help${hash}` : `/help/${slug ?? ''}${hash}`;
}

/** True for links leaving the application (they open in a new tab). */
export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Pages containing every word of the query, those matching in their title first, with an
 * extract around the first match.
 */
export function searchPages(pages: HelpPage[], query: string): SearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const results: (SearchResult & { inTitle: boolean })[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const text = page.text.toLowerCase();
    if (!words.every((word) => title.includes(word) || text.includes(word))) continue;
    results.push({
      slug: page.slug,
      title: page.title,
      snippet: snippet(page.text, text, words),
      inTitle: words.some((word) => title.includes(word)),
    });
  }
  return results
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle))
    .map(({ slug, title, snippet }) => ({ slug, title, snippet }));
}

const SNIPPET_LENGTH = 160;

function snippet(text: string, lowerText: string, words: string[]): string {
  const positions = words.map((word) => lowerText.indexOf(word)).filter((at) => at >= 0);
  const first = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 40);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
