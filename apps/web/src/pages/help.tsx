import { useEffect } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { Link, NavLink, useLocation, useParams, useSearchParams } from 'react-router';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { Shell } from '../components/shell';
import { Loading } from '../components/ui';
import { findPage, helpPages } from '../help/content';
import { helpHref, isExternal, searchPages } from '../help/pages';
import { useSession } from '../queries';

// Links between pages stay in the application; links to other sites open in a new tab.
const components: Components = {
  a: ({ href = '', children }) => {
    if (isExternal(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    if (href.startsWith('#')) return <a href={href}>{children}</a>;
    return <Link to={helpHref(href)}>{children}</Link>;
  },
};

/** Scrolls to the heading named in the address (`/help/page#heading`), or to the top. */
function useScrollToHash(slug: string) {
  const { hash } = useLocation();
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [slug, hash]);
}

function HelpNavigation() {
  return (
    <nav aria-label="Help pages">
      <ul className="space-y-1">
        {helpPages.map((page) => (
          <li key={page.slug}>
            <NavLink
              to={page.slug === 'index' ? '/help' : `/help/${page.slug}`}
              end
              className={({ isActive }) =>
                `block rounded px-2 py-1 ${isActive ? 'bg-slate-200 font-medium' : 'text-blue-700 hover:bg-slate-100'}`
              }
            >
              {page.title}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SearchResults({ query }: { query: string }) {
  const results = searchPages(helpPages, query);
  return (
    <section aria-label="Search results" className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Search: {query}</h1>
      {results.length === 0 ? (
        <p>No page contains all these words.</p>
      ) : (
        <ul className="space-y-4">
          {results.map((result) => (
            <li key={result.slug}>
              <Link
                to={result.slug === 'index' ? '/help' : `/help/${result.slug}`}
                className="font-medium text-blue-700 underline"
              >
                {result.title}
              </Link>
              <p className="text-sm text-slate-700">{result.snippet}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HelpContent() {
  const { slug = 'index' } = useParams();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const page = findPage(slug);
  useScrollToHash(slug);

  return (
    <div className="lg:flex lg:gap-8">
      <aside className="mb-6 lg:mb-0 lg:w-60 lg:shrink-0">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label className="block">
            <span className="block font-medium text-slate-800">Search Help</span>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setParams(event.target.value ? { q: event.target.value } : {}, { replace: true });
              }}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2"
            />
          </label>
        </form>
        <details className="mt-4 lg:hidden">
          <summary className="cursor-pointer font-medium">All Help pages</summary>
          <div className="mt-2">
            <HelpNavigation />
          </div>
        </details>
        <div className="mt-4 hidden lg:block">
          <HelpNavigation />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {query.trim() ? (
          <SearchResults query={query} />
        ) : page ? (
          <article className="prose-help max-w-3xl">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug]}
              components={components}
            >
              {page.markdown}
            </Markdown>
          </article>
        ) : (
          <p>
            This Help page does not exist.{' '}
            <Link to="/help" className="text-blue-700 underline">
              Help contents
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** Help (02, section 11): open to everyone, so the login page and the wizard can link to it. */
export default function HelpPage() {
  const session = useSession();
  if (session.isPending) return <Loading />;
  if (session.data) {
    return (
      <Shell>
        <HelpContent />
      </Shell>
    );
  }
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold text-slate-900">Orchestrator Help</p>
        <Link to="/login" className="text-blue-700 underline">
          Back to the Orchestrator
        </Link>
      </div>
      <HelpContent />
    </div>
  );
}
