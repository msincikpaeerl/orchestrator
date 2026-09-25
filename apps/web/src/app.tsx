import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Shell, sections } from './components/shell';
import { ActivityPage } from './pages/activity';
import { CenteredPage, Loading } from './components/ui';
import { ComingLaterPage } from './pages/coming-later';
import { LoginPage } from './pages/login';
import { AddMachinePage } from './pages/add-machine';
import { MachinePage } from './pages/machine';
import { MachinesPage } from './pages/machines';
import { NeedsYouPage } from './pages/needs-you';
import { NewProjectPage } from './pages/new-project';
import { ProjectPage, ProjectSettingsPage } from './pages/project';
import { ProjectsPage } from './pages/projects';
import { EditTicketPage, NewTicketPage } from './pages/ticket-form';
import { LimitsPage } from './pages/limits';
import { GitHubSettingsPage, SettingsPage } from './pages/settings';
import { SetupDonePage, SetupPage } from './pages/setup';
import { useSession, useSetupState } from './queries';

// Loaded on first use: Markdown rendering and the pages are most of the UI's size.
const HelpPage = lazy(() => import('./pages/help'));
const TicketPage = lazy(() =>
  import('./pages/ticket').then((module) => ({ default: module.TicketPage })),
);

/** Sections of later lots, with their purpose from 02, section 2. */
const later: Record<string, string> = {
  '/requests': 'Talk to the Project Manager.',
  '/agents': 'Default and custom agent profiles.',
};

/**
 * Logged-in screens. Until setup is done, sends the owner to the wizard; without a session, to
 * the login page and back here afterwards.
 */
function RequireSetup() {
  const setup = useSetupState();
  const session = useSession();
  const location = useLocation();
  if (setup.isPending || session.isPending) return <Loading />;
  if (setup.isError || session.isError) {
    return <CenteredPage>The Orchestrator could not be reached. Reload the page.</CenteredPage>;
  }
  if (!setup.data.ownerCreated) return <Navigate to="/setup" replace />;
  if (!session.data) {
    const next = location.pathname + location.search + location.hash;
    return (
      <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
    );
  }
  if (!setup.data.githubConnected) return <Navigate to="/setup" replace />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

function NotFoundPage() {
  return <p>This page does not exist.</p>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:slug" element={<HelpPage />} />
        <Route path="/setup/done" element={<SetupDonePage />} />
        <Route element={<RequireSetup />}>
          <Route index element={<NeedsYouPage />} />
          {sections
            .filter(({ path }) => path in later)
            .map(({ path, label }) => (
              <Route
                key={path}
                path={path}
                element={<ComingLaterPage title={label} purpose={later[path] ?? ''} />}
              />
            ))}
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/projects/:key" element={<ProjectPage />} />
          <Route path="/projects/:key/settings" element={<ProjectSettingsPage />} />
          <Route path="/projects/:key/tickets/new" element={<NewTicketPage />} />
          <Route path="/projects/:key/tickets/:number" element={<TicketPage />} />
          <Route path="/projects/:key/tickets/:number/edit" element={<EditTicketPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/machines/new" element={<AddMachinePage />} />
          <Route path="/machines/:id" element={<MachinePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/github" element={<GitHubSettingsPage />} />
          <Route path="/settings/limits" element={<LimitsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
