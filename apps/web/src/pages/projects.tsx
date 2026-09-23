import type { Project } from '@orchestrator/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../github/text';
import { ArchiveAction } from '../projects/archive-action';
import { kindLabel, repositoryUrl } from '../projects/text';
import { useProjects } from '../queries';
import { buttonLinkClass, Card, ErrorMessage, Loading, PageHeader } from '../components/ui';

/** Ready, setting up, setup failed, archived: what the list says about a project's state. */
export function ProjectBadges({ project }: { project: Project }) {
  const badges: { text: string; look: string }[] = [];
  if (project.status === 'archived') {
    badges.push({ text: 'Archived', look: 'bg-slate-200 text-slate-800' });
  }
  if (project.setup.status === 'in_progress') {
    badges.push({ text: 'Setting up', look: 'bg-blue-100 text-blue-900' });
  } else if (project.setup.status === 'failed') {
    badges.push({ text: 'Setup failed', look: 'bg-red-100 text-red-900' });
  }
  return badges.map((badge) => (
    <span key={badge.text} className={`rounded px-2 py-0.5 text-sm ${badge.look}`}>
      {badge.text}
    </span>
  ));
}

/** Projects (02, section 6.1). Archived projects appear with "Show archived". */
export function ProjectsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const projects = useProjects(showArchived);

  return (
    <>
      <PageHeader title="Projects" help="projects" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/projects/new" className={buttonLinkClass}>
          New project
        </Link>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={showArchived}
            onChange={(event) => {
              setShowArchived(event.target.checked);
            }}
          />
          Show archived
        </label>
      </div>
      {projects.isPending ? (
        <Loading />
      ) : projects.isError ? (
        <ErrorMessage>The projects could not be loaded. Reload the page.</ErrorMessage>
      ) : projects.data.projects.length === 0 ? (
        <Card>
          <p>
            No project yet. Click <strong>New project</strong> to create one with a new GitHub
            repository, or to link one of your repositories.
          </p>
        </Card>
      ) : (
        <ul aria-label="Projects" className="space-y-3">
          {projects.data.projects.map((project) => (
            <li key={project.id}>
              <Card className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/projects/${project.key}`}
                      className="font-semibold break-words text-blue-700 underline"
                    >
                      {project.key} · {project.name}
                    </Link>
                    <ProjectBadges project={project} />
                  </div>
                  <p className="text-slate-700">
                    {kindLabel[project.kind]} ·{' '}
                    <a
                      href={repositoryUrl(project.repository)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-blue-700 underline"
                    >
                      {project.repository.owner}/{project.repository.name}
                    </a>{' '}
                    ({project.repository.private ? 'private' : 'public'})
                  </p>
                  <p className="text-sm text-slate-600">
                    Last change {formatDateTime(project.updatedAt)}
                  </p>
                </div>
                <div className="shrink-0">
                  <ArchiveAction project={project} />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
