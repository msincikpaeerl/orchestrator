import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The only link schemes of untrusted Markdown (01, section 3.5; ADR 0024). */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address if it is absolute and uses an allowed scheme, else null. Relative addresses are
 * refused too: an explicit allow-list, not react-markdown's default transform, which lets other
 * schemes and relative addresses through.
 */
export function safeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
}

const linkClass = 'break-all text-blue-700 underline';

const components: Components = {
  // A refused address leaves the text, without a link.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Images are never loaded, so viewing content never contacts another site (09, section 5).
  img: ({ src, alt }) => {
    const text = `Image: ${alt || (typeof src === 'string' ? src : 'no description')}`;
    return typeof src === 'string' && src !== '' ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {text}
      </a>
    ) : (
      <span>[{text}]</span>
    );
  },
};

/**
 * Markdown written by the owner or agents: descriptions, acceptance criteria, comments (01,
 * section 3.5). Raw HTML is shown as text, never rendered; links only use `http`, `https` or
 * `mailto` and open in a new tab without giving this page to the other site; images are links.
 * Help pages, which come with the application, use their own rendering (ADR 0020).
 */
export function UntrustedMarkdown({ children }: { children: string }) {
  return (
    <div className="prose-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeUrl(url)}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
