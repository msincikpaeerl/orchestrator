import {
  Project,
  ReviewsAutomaticRequest,
  SETUP_STEPS,
  UpdateProjectRequest,
  type Project as ProjectData,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  ErrorMessage,
  HelpLink,
  InfoMessage,
  Loading,
  PageHeader,
  TextArea,
  TextField,
} from '../components/ui';
import { formatDateTime } from '../github/text';
import { ArchiveAction } from '../projects/archive-action';
import {
  branchProtectionLabel,
  harnessElement,
  kindLabel,
  refusalText,
  repositoryUrl,
  reviewsSwitch,
  sentence,
  stepLabel,
} from '../projects/text';
import { projectsChanged, useProject } from '../queries';
import { ProjectOverrides } from '../settings/project-overrides';
import { Board } from '../tickets/board';
import { ProjectBadges } from './projects';

function projectPath(project: ProjectData, action: string): string {
  return `/api/projects/${encodeURIComponent(project.key)}/${action}`;
}

/** Loads the project of the address, or says why it cannot. */
export function WithProject({ children }: { children: (project: ProjectData) => ReactNode }) {
  const { key = '' } = useParams();
  const project = useProject(key);
  if (project.isPending) return <Loading />;
  if (project.isError) {
    const missing =
      project.error instanceof ApiRequestError && project.error.code === 'project_not_found';
    return (
      <div className="space-y-3">
        <ErrorMessage>
          {missing
            ? 'This project does not exist.'
            : 'The project could not be loaded. Reload the page.'}
        </ErrorMessage>
        <Link to="/projects" className="text-blue-700 underline">
          Back to the projects
        </Link>
      </div>
    );
  }
  return children(project.data);
}

function ArchivedNotice({ project }: { project: ProjectData }) {
  if (project.status !== 'archived') return null;
  return (
    <InfoMessage>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>This project is archived: it is read-only and no work starts on it.</p>
        <ArchiveAction project={project} />
      </div>
    </InfoMessage>
  );
}

/** The steps of the repository setup, with where it is (08, sections 3.1 and 3.4). */
function SetupSteps({ project }: { project: ProjectData }) {
  const steps = SETUP_STEPS[project.repository.origin];
  const { status, step } = project.setup;
  const current = step === null ? steps.length : steps.indexOf(step);
  return (
    <ol aria-label="Setup steps" className="space-y-1">
      {steps.map((each, index) => {
        const state =
          index < current || status === 'ready'
            ? 'Done'
            : index > current
              ? 'Waiting'
              : status === 'failed'
                ? 'Failed'
                : 'Running…';
        return (
          <li key={each} className="flex flex-wrap justify-between gap-x-4">
            <span>{stepLabel[each]}</span>
            <span
              className={
                state === 'Failed'
                  ? 'font-medium text-red-700'
                  : state === 'Done'
                    ? 'text-green-800'
                    : 'text-slate-600'
              }
            >
              {state}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SetupCard({ project }: { project: ProjectData }) {
  const retry = useMutation({
    mutationFn: () => api('POST', projectPath(project, 'setup/retry'), Project),
    onSuccess: (changed) => projectsChanged(changed),
  });
  const { status, failure } = project.setup;
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Repository setup</h2>
      <div aria-live="polite" className="space-y-3">
        {status === 'in_progress' && <p>Setting up the repository. This page updates by itself.</p>}
        {status === 'ready' && <p className="font-medium text-green-800">Ready.</p>}
        {status === 'failed' && (
          <ErrorMessage>
            The setup failed: {sentence(failure ?? 'no reason was recorded')}{' '}
            <HelpLink page="projects#if-the-setup-fails">What to do</HelpLink>
          </ErrorMessage>
        )}
        <SetupSteps project={project} />
      </div>
      {status === 'failed' &&
        (project.status === 'archived' ? (
          <p className="text-slate-700">Unarchive the project to try the setup again.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-slate-700">
              Try again continues from the failed step; the steps already done are kept.
            </p>
            {retry.error && <ErrorMessage>{refusalText(retry.error).text}</ErrorMessage>}
            <Button
              onClick={() => {
                retry.mutate();
              }}
              disabled={retry.isPending}
            >
              Try again
            </Button>
          </div>
        ))}
    </Card>
  );
}

function BranchProtectionCard({ project }: { project: ProjectData }) {
  const protection = project.branchProtection;
  if (protection === null) return null;
  return (
    <Card className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">Branch protection</h2>
      {protection === 'not_available' ? (
        <InfoMessage>
          <p>
            <strong>Not available on your GitHub plan.</strong> This is not a problem: agents still
            never write to the default branch.{' '}
            <HelpLink page="projects#branch-protection">What this means</HelpLink>
          </p>
        </InfoMessage>
      ) : (
        <p>
          {branchProtectionLabel[protection]}.{' '}
          <HelpLink page="projects#branch-protection">What this means</HelpLink>
        </p>
      )}
    </Card>
  );
}

/** Missing harness elements of a linked repository, with **Check again** (08, section 3.4). */
function HarnessCard({ project }: { project: ProjectData }) {
  const check = useMutation({
    mutationFn: () => api('POST', projectPath(project, 'harness/check'), Project),
    onSuccess: (changed) => projectsChanged(changed),
  });
  if (project.repository.origin !== 'linked' || project.harness === null) return null;
  const { missing, checkedAt } = project.harness;
  const canCheck = project.status === 'active' && project.setup.status === 'ready';
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Harness elements</h2>
      {missing.length === 0 ? (
        <p>Every harness element was found in the repository.</p>
      ) : (
        <>
          <p>
            These elements help agents work well and were not found in the repository. You can still
            create tickets.
          </p>
          <ul aria-label="Missing harness elements" className="list-disc space-y-1 pl-6">
            {missing.map((element) => (
              <li key={element}>
                {harnessElement[element].label}{' '}
                <HelpLink page={harnessElement[element].help}>What is it?</HelpLink>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-sm text-slate-600">Checked {formatDateTime(checkedAt)}.</p>
      {check.error && <ErrorMessage>{refusalText(check.error).text}</ErrorMessage>}
      {canCheck && (
        <Button
          variant="secondary"
          onClick={() => {
            check.mutate();
          }}
          disabled={check.isPending}
        >
          {check.isPending ? 'Checking…' : 'Check again'}
        </Button>
      )}
    </Card>
  );
}

/**
 * Project page (02, sections 6.2 and 6.3): repository, the board once the setup is done, setup
 * progress and result, branch protection, missing harness elements.
 */
export function ProjectPage() {
  return (
    <WithProject>
      {(project) => (
        <>
          <PageHeader title={`${project.key} · ${project.name}`} help="projects" />
          <div className="space-y-4">
            <ArchivedNotice project={project} />
            <Card className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <ProjectBadges project={project} />
              </div>
              {project.description !== '' && (
                <p className="break-words text-slate-800">{project.description}</p>
              )}
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="text-slate-600">Kind</dt>
                <dd>{kindLabel[project.kind]}</dd>
                <dt className="text-slate-600">Repository</dt>
                <dd className="min-w-0">
                  <a
                    href={repositoryUrl(project.repository)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-blue-700 underline"
                  >
                    {project.repository.owner}/{project.repository.name}
                  </a>{' '}
                  ({project.repository.private ? 'private' : 'public'},{' '}
                  {project.repository.origin === 'created'
                    ? 'created by the Orchestrator'
                    : 'linked'}
                  )
                </dd>
              </dl>
              <Link
                to={`/projects/${project.key}/settings`}
                className="inline-block text-blue-700 underline"
              >
                Project settings
              </Link>
            </Card>
            {project.setup.status === 'ready' && (
              <section aria-labelledby="tickets-heading" className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="tickets-heading" className="text-xl font-semibold text-slate-900">
                    Tickets
                  </h2>
                  <HelpLink page="tickets">Help about tickets</HelpLink>
                </div>
                <Board project={project} />
              </section>
            )}
            <SetupCard project={project} />
            <BranchProtectionCard project={project} />
            <HarnessCard project={project} />
          </div>
        </>
      )}
    </WithProject>
  );
}

function SettingsForm({ project }: { project: ProjectData }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const save = useMutation({
    mutationFn: (changes: UpdateProjectRequest) =>
      api(
        'PATCH',
        `/api/projects/${encodeURIComponent(project.key)}`,
        Project,
        UpdateProjectRequest.parse(changes),
      ),
    onSuccess: (changed) => projectsChanged(changed),
  });
  const archived = project.status === 'archived';
  const nameError = name.trim() === '' ? 'Enter a name.' : null;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (nameError) return;
    save.mutate({ name: name.trim(), description: description.trim() });
  }

  return (
    <form className="space-y-4" onSubmit={submit} aria-label="Name and description" noValidate>
      <TextField
        label="Name"
        value={name}
        maxLength={100}
        disabled={archived}
        error={nameError}
        onChange={(event) => {
          setName(event.target.value);
          save.reset();
        }}
      />
      <TextArea
        label="Description"
        value={description}
        maxLength={1000}
        disabled={archived}
        onChange={(event) => {
          setDescription(event.target.value);
          save.reset();
        }}
      />
      {save.error && <ErrorMessage>{refusalText(save.error).text}</ErrorMessage>}
      {save.isSuccess && (
        <p role="status" className="text-green-800">
          Saved.
        </p>
      )}
      {archived ? (
        <p className="text-slate-700">Unarchive the project to change its name or description.</p>
      ) : (
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );
}

/** **Start reviews by themselves** (02, section 6.5; lot 4 step D3), saved at each change. */
function ReviewsSwitch({ project }: { project: ProjectData }) {
  // Shown at once, put back if the server refuses it.
  const [on, setOn] = useState(project.reviewsAutomatic);
  const save = useMutation({
    mutationFn: (on: boolean) =>
      api(
        'PUT',
        projectPath(project, 'reviews-automatic'),
        Project,
        ReviewsAutomaticRequest.parse({ on }),
      ),
    onSuccess: (changed) => projectsChanged(changed),
    onError: () => {
      setOn(project.reviewsAutomatic);
    },
  });
  const archived = project.status === 'archived';
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">{reviewsSwitch.heading}</h2>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={archived || save.isPending}
          onChange={(event) => {
            setOn(event.target.checked);
            save.mutate(event.target.checked);
          }}
        />
        <span>
          {reviewsSwitch.label}
          <span className="block text-sm text-slate-600">{reviewsSwitch.hint}</span>
        </span>
      </label>
      {save.error && <ErrorMessage>{refusalText(save.error).text}</ErrorMessage>}
      {save.isSuccess && (
        <p role="status" className="text-green-800">
          {on ? reviewsSwitch.on : reviewsSwitch.off}
        </p>
      )}
      <p className="text-sm text-slate-600">
        <HelpLink page="tickets#review-by-quality">Review by Quality</HelpLink>
      </p>
    </Card>
  );
}

/**
 * Project settings (02, section 6.5): name and description, Start reviews by themselves, overrides
 * of settings, archive and unarchive.
 */
export function ProjectSettingsPage() {
  return (
    <WithProject>
      {(project) => (
        <>
          <PageHeader title="Project settings" help="projects" />
          <div className="space-y-4">
            <Link to={`/projects/${project.key}`} className="inline-block text-blue-700 underline">
              Back to {project.key} · {project.name}
            </Link>
            <ArchivedNotice project={project} />
            <Card>
              <SettingsForm project={project} />
            </Card>
            <ReviewsSwitch project={project} />
            <Card className="space-y-2">
              <h2 className="text-lg font-semibold text-slate-900">Cannot be changed</h2>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="text-slate-600">Key</dt>
                <dd>{project.key}</dd>
                <dt className="text-slate-600">Repository</dt>
                <dd className="break-all">
                  {project.repository.owner}/{project.repository.name}
                </dd>
                <dt className="text-slate-600">Kind</dt>
                <dd>{kindLabel[project.kind]}</dd>
              </dl>
            </Card>
            <ProjectOverrides project={project} />
            {project.status === 'active' && (
              <Card className="space-y-3">
                <h2 className="text-lg font-semibold text-slate-900">Archive the project</h2>
                <p className="text-slate-700">
                  An archived project is kept, read-only, and hidden from the project list. The
                  GitHub repository is not changed. You can unarchive it later.
                </p>
                <ArchiveAction project={project} />
              </Card>
            )}
          </div>
        </>
      )}
    </WithProject>
  );
}
