import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { api } from '../api';
import { keys, queryClient, useGitHubStatus, useNeedsYou } from '../queries';

/** The sections of 02, section 2, in its order. */
export const sections = [
  { path: '/', label: 'Needs you' },
  { path: '/requests', label: 'Requests' },
  { path: '/projects', label: 'Projects' },
  { path: '/activity', label: 'Activity' },
  { path: '/agents', label: 'Agents' },
  { path: '/machines', label: 'Machines' },
  { path: '/settings', label: 'Settings' },
  { path: '/help', label: 'Help' },
] as const;

/** Number of items in "Needs you", for the badge (02, section 1). */
function useNeedsYouCount(): number {
  const github = useGitHubStatus();
  const needsYou = useNeedsYou();
  return (
    (github.data?.connected ? github.data.problems.length : 0) + (needsYou.data?.items.length ?? 0)
  );
}

function Navigation({ onNavigate }: { onNavigate: () => void }) {
  const count = useNeedsYouCount();
  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {sections.map(({ path, label }) => (
          <li key={path}>
            <NavLink
              to={path}
              end={path === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                `flex items-center justify-between rounded px-3 py-2 ${
                  isActive
                    ? 'bg-slate-200 font-medium text-slate-900'
                    : 'text-slate-700 hover:bg-slate-100'
                }`
              }
            >
              {label}
              {path === '/' && count > 0 && (
                <span
                  aria-label={`${String(count)} items`}
                  className="rounded-full bg-red-600 px-2 text-sm text-white"
                >
                  {count}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Layout of the logged-in screens: navigation beside the page, or behind "Menu" on a phone. */
export function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => api('POST', '/api/auth/logout', null),
    onSuccess: async () => {
      queryClient.setQueryData(keys.session, null);
      queryClient.removeQueries({ queryKey: keys.github });
      queryClient.removeQueries({ queryKey: keys.needsYou });
      queryClient.removeQueries({ queryKey: keys.projects });
      await navigate('/login');
    },
  });
  const close = () => {
    setMenuOpen(false);
  };

  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <Link to="/" className="font-semibold text-slate-900" onClick={close}>
          Orchestrator
        </Link>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1"
          aria-expanded={menuOpen}
          aria-controls="main-menu"
          onClick={() => {
            setMenuOpen(!menuOpen);
          }}
        >
          Menu
        </button>
      </header>
      <aside
        id="main-menu"
        className={`${menuOpen ? 'block' : 'hidden'} border-b border-slate-200 bg-white p-4 md:block md:min-h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0`}
      >
        <Link to="/" className="mb-6 hidden font-semibold text-slate-900 md:block">
          Orchestrator
        </Link>
        <Navigation onNavigate={close} />
        <button
          type="button"
          className="mt-6 px-3 text-slate-600 underline"
          onClick={() => {
            logout.mutate();
          }}
        >
          Log out
        </button>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
