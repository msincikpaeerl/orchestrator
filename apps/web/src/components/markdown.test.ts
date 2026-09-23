import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { safeUrl, UntrustedMarkdown } from './markdown';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(UntrustedMarkdown, null, markdown));
}

/** Every opening tag of the output, with its attributes as written. */
function tags(html: string): { name: string; attributes: string }[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)].map((match) => ({
    name: (match[1] ?? '').toLowerCase(),
    attributes: match[2] ?? '',
  }));
}

/** Elements that run code, load something or send something. */
const ACTIVE_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'object',
  'embed',
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'svg',
  'math',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'button',
];

/**
 * The proof that nothing can run or load: no active element, no event handler, style or `src`
 * attribute, and every link to an allowed scheme, opened without giving this page away.
 */
function expectInert(html: string) {
  for (const { name, attributes } of tags(html)) {
    expect(ACTIVE_ELEMENTS, html).not.toContain(name);
    expect(attributes, html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(attributes, html).not.toMatch(/\s(src|srcset|style|formaction|action)\s*=/i);
    for (const [, href = ''] of attributes.matchAll(/\shref="([^"]*)"/g)) {
      expect(href, html).toMatch(/^(https?:\/\/|mailto:)/);
    }
    if (name === 'a' && /\shref=/.test(attributes)) {
      expect(attributes).toContain('rel="noopener noreferrer"');
      expect(attributes).toContain('target="_blank"');
    }
  }
}

describe('UntrustedMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const html = render('# Title\n\n- **bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
    expectInert(html);
  });

  it.each([
    [
      'a script element',
      'Hello <script>alert(1)</script>',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    ],
    ['a script block', '<script>\nalert(1)\n</script>', '&lt;script&gt;'],
    ['an iframe', '<iframe src="https://example.com"></iframe>', '&lt;iframe'],
    ['a style element', '<style>body { display: none }</style>', '&lt;style&gt;'],
    ['a form', '<form action="https://example.com"><button>Go</button></form>', '&lt;form'],
  ])('shows %s as text, never as HTML', (_, markdown, text) => {
    const html = render(markdown);
    expect(html).toContain(text);
    expectInert(html);
  });

  it.each([
    '<img src="x" onerror="alert(1)">',
    '<a href="https://example.com" onclick="alert(1)">x</a>',
    '<div onmouseover="alert(1)">hover</div>',
    '<svg onload="alert(1)"></svg>',
    '<details open ontoggle="alert(1)">x</details>',
    '<p style="background:url(https://example.com/track)">x</p>',
  ])('never keeps event handlers or styles: %s', (markdown) => {
    const html = render(markdown);
    expectInert(html);
    expect(html).toContain('&lt;');
  });

  it.each([
    ['javascript:', '[click](javascript:alert(1))'],
    ['mixed case', '[click](JaVaScRiPt:alert(1))'],
    ['angle brackets and spaces', '[click](< javascript:alert(1)>)'],
    ['a tab inside the scheme', '[click](java\tscript:alert(1))'],
    ['an entity for the colon', '[click](javascript&#58;alert(1))'],
    ['an entity for a letter', '[click](&#106;avascript:alert(1))'],
    ['a reference link', '[click][r]\n\n[r]: javascript:alert(1)'],
    ['an autolink', '<javascript:alert(1)>'],
    ['vbscript:', '[click](vbscript:msgbox(1))'],
    ['data:', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['file:', '[click](file:///etc/passwd)'],
    ['a relative address', '[click](/api/projects)'],
    ['a protocol-relative address', '[click](//example.com)'],
    ['a fragment', '[click](#top)'],
  ])('keeps the text but not the link for %s', (_, markdown) => {
    const html = render(markdown);
    expect(html).not.toContain('href');
    expectInert(html);
  });

  it('keeps http, https and mailto links, opened in a new tab without giving this page away', () => {
    const html = render(
      '[site](https://example.com/a?b=1) [plain](http://example.com) [mail](mailto:me@example.com) www.example.org',
    );
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('href="http://example.com/"');
    expect(html).toContain('href="mailto:me@example.com"');
    expect(html).toContain('href="http://www.example.org/"');
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(4);
    expectInert(html);
  });

  it('shows images as links, never loaded', () => {
    const html = render('![The logo](https://example.com/logo.png)');
    expect(html).toContain(
      '<a href="https://example.com/logo.png" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain('Image: The logo');
    expectInert(html);
  });

  it('shows an image with a refused address as text only', () => {
    for (const markdown of [
      '![pixel](data:image/png;base64,iVBORw0KGgo=)',
      '![x](javascript:alert(1))',
      '![local](/api/secret.png)',
    ]) {
      const html = render(markdown);
      expect(html).not.toContain('href');
      expect(html).toContain('[Image: ');
      expectInert(html);
    }
  });

  it('shows HTML entities as the characters they stand for, never as markup', () => {
    const html = render(
      '&lt;script&gt;alert(1)&lt;/script&gt; &#60;img src=x onerror=alert(1)&#62; &amp;',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expectInert(html);
  });
});

describe('safeUrl', () => {
  it('accepts only absolute http, https and mailto addresses', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com/');
    expect(safeUrl('HTTP://EXAMPLE.COM/A')).toBe('http://example.com/A');
    expect(safeUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
    for (const refused of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,x',
      'blob:https://example.com/1',
      'ftp://example.com',
      'tel:123',
      '/relative',
      '//example.com',
      '#anchor',
      '',
    ]) {
      expect(safeUrl(refused), refused).toBeNull();
    }
  });
});
