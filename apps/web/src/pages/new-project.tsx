import {
  AvailabilityResponse,
  defaultRequiredCapabilities,
  LinkableRepositoriesResponse,
  Project,
  ProjectKey,
  ProjectKind,
  RepositoryName,
  slugify,
  type CreateProjectRequest,
} from '@orchestrator/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import {
  Button,
  Card,
  ErrorMessage,
  FieldError,
  HelpLink,
  Loading,
  PageHeader,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui';
import { kindHint, kindLabel, refusalText, suggestKey, type ErrorField } from '../projects/text';
import { projectsChanged } from '../queries';

type Way = 'created' | 'linked';

/** The value once the owner has stopped typing for a moment, for availability checks. */
function useSettled(value: string, delayMs = 400): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return settled;
}

/** Asks the server whether a key or a repository name is free. */
function useAvailability(field: 'key' | 'repositoryName', value: string, enabled: boolean) {
  const settled = useSettled(value);
  const query = useQuery({
    queryKey: ['availability', field, settled],
    queryFn: () =>
      api(
        'GET',
        `/api/projects/availability?${field}=${encodeURIComponent(settled)}`,
        AvailabilityResponse,
      ),
    enabled: enabled && settled === value,
    staleTime: 0,
    gcTime: 0,
  });
  return settled === value && enabled ? query.data?.[field] : undefined;
}

function WayChoice({ way, onChange }: { way: Way; onChange: (way: Way) => void }) {
  const options: { value: Way; label: string; detail: string }[] = [
    {
      value: 'created',
      label: 'Create a new repository',
      detail: 'The Orchestrator creates it on your GitHub account with the starting files.',
    },
    {
      value: 'linked',
      label: 'Link an existing repository',
      detail: 'One of your repositories, left as it is: nothing is written to it.',
    },
  ];
  return (
    <fieldset>
      <legend className="font-medium text-slate-800">How do you want to start?</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer gap-3 rounded border p-3 ${
              way === option.value ? 'border-blue-700 bg-blue-50' : 'border-slate-300'
            }`}
          >
            <input
              type="radio"
              name="way"
              className="mt-1 h-5 w-5 shrink-0"
              checked={way === option.value}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span>
              <span className="block font-medium">{option.label}</span>
              <span className="block text-sm text-slate-600">{option.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** New project (02, section 6.2): a new repository, or one of the owner's existing ones. */
export function NewProjectPage() {
  const navigate = useNavigate();
  const [way, setWay] = useState<Way>('created');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [kind, setKind] = useState<ProjectKind>('web_app');
  const [description, setDescription] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [repositoryEdited, setRepositoryEdited] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [linked, setLinked] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [refusal, setRefusal] = useState<{ field: ErrorField; text: string } | null>(null);

  const linkable = useQuery({
    queryKey: ['projects', 'linkable-repositories'],
    queryFn: () => api('GET', '/api/projects/linkable-repositories', LinkableRepositoriesResponse),
    enabled: way === 'linked',
  });

  const keyValid = ProjectKey.safeParse(key).success;
  const keyAvailability = useAvailability('key', key, keyValid);
  const repositoryValid = RepositoryName.safeParse(repositoryName).success;
  const repositoryAvailability = useAvailability(
    'repositoryName',
    repositoryName,
    way === 'created' && repositoryValid,
  );

  const create = useMutation({
    mutationFn: (request: CreateProjectRequest) => api('POST', '/api/projects', Project, request),
    onSuccess: async (project) => {
      await projectsChanged(project);
      await navigate(`/projects/${project.key}`);
    },
    onError: (error) => {
      setRefusal(refusalText(error));
    },
  });

  /** A refusal is shown until the field it is about changes. */
  function clearRefusal(field: ErrorField) {
    if (refusal?.field === field || refusal?.field === 'form') setRefusal(null);
  }

  function changeName(value: string) {
    setName(value);
    // The suggested key and repository name may change with it.
    setRefusal(null);
    if (!keyEdited) setKey(suggestKey(value));
    if (!repositoryEdited) setRepositoryName(slugify(value));
  }

  const nameError = submitted && name.trim() === '' ? 'Enter a name.' : null;
  const keyError =
    refusal?.field === 'key'
      ? refusal.text
      : key !== '' && !keyValid
        ? 'Use 2 to 6 capital letters, for example WEB.'
        : keyAvailability === 'taken'
          ? 'Another project already uses this key (archived projects count too). Choose another key.'
          : submitted && key === ''
            ? 'Enter a key.'
            : null;
  const repositoryError =
    refusal?.field === 'repository'
      ? refusal.text
      : way === 'created'
        ? repositoryName !== '' && !repositoryValid
          ? 'Use only letters, digits, “.”, “-” and “_”.'
          : repositoryAvailability === 'taken'
            ? 'A repository with this name already exists on your GitHub account. Choose another name, or link that repository instead.'
            : submitted && repositoryName === ''
              ? 'Enter a repository name.'
              : null
        : submitted && linked === ''
          ? 'Choose a repository.'
          : null;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitted(true);
    setRefusal(null);
    const ready =
      name.trim() !== '' &&
      keyValid &&
      (way === 'created' ? repositoryValid : linked !== '') &&
      keyAvailability !== 'taken' &&
      (way === 'linked' || repositoryAvailability !== 'taken');
    if (!ready) return;
    create.mutate({
      name: name.trim(),
      key,
      kind,
      description: description.trim(),
      repository:
        way === 'created'
          ? { origin: 'created', name: repositoryName, private: isPrivate }
          : { origin: 'linked', name: linked },
    });
  }

  return (
    <>
      <PageHeader title="New project" help="projects" />
      <Card>
        <form className="space-y-5" onSubmit={submit} noValidate>
          <WayChoice
            way={way}
            onChange={(value) => {
              setWay(value);
              setRefusal(null);
            }}
          />

          {way === 'linked' && (
            <div>
              {linkable.isPending ? (
                <Loading />
              ) : linkable.isError ? (
                <ErrorMessage>
                  Your repositories could not be read: {refusalText(linkable.error).text}
                </ErrorMessage>
              ) : linkable.data.repositories.length === 0 ? (
                <ErrorMessage>
                  No repository can be linked: every repository of your GitHub account is archived
                  or already linked to a project.
                </ErrorMessage>
              ) : (
                <SelectField
                  label="Repository"
                  hint="Your repositories that are not archived and not linked to a project yet."
                  value={linked}
                  error={repositoryError}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    setLinked(chosen);
                    clearRefusal('repository');
                    if (name === '' && chosen !== '') changeName(chosen);
                  }}
                >
                  <option value="">Choose a repository</option>
                  {linkable.data.repositories.map((repository) => (
                    <option key={repository.name} value={repository.name}>
                      {repository.name} ({repository.private ? 'private' : 'public'})
                    </option>
                  ))}
                </SelectField>
              )}
            </div>
          )}

          <TextField
            label="Name"
            value={name}
            maxLength={100}
            error={nameError}
            onChange={(event) => {
              changeName(event.target.value);
            }}
          />
          <TextField
            label="Key"
            hint="2 to 6 capital letters. It starts every ticket number (for example WEB-12) and cannot be changed later."
            value={key}
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            error={keyError}
            onChange={(event) => {
              setKey(event.target.value.toUpperCase());
              setKeyEdited(true);
              clearRefusal('key');
            }}
          />
          <SelectField
            label="Kind"
            hint={
              <>
                {kindHint(kind)}
                {defaultRequiredCapabilities(kind).length > 0 && (
                  <>
                    {' '}
                    <HelpLink page="machines#browser-tests">Browser tests</HelpLink>
                  </>
                )}
              </>
            }
            value={kind}
            onChange={(event) => {
              setKind(ProjectKind.parse(event.target.value));
            }}
          >
            {ProjectKind.options.map((option) => (
              <option key={option} value={option}>
                {kindLabel[option]}
              </option>
            ))}
          </SelectField>
          <TextArea
            label="Description"
            hint="Optional. One or two sentences."
            value={description}
            maxLength={1000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />

          {way === 'created' && (
            <>
              <TextField
                label="Repository name"
                hint="The name of the new repository on your GitHub account, made from the project name. You can change it."
                value={repositoryName}
                maxLength={100}
                autoCapitalize="none"
                autoComplete="off"
                error={repositoryError}
                onChange={(event) => {
                  setRepositoryName(event.target.value);
                  setRepositoryEdited(true);
                  clearRefusal('repository');
                }}
              />
              {repositoryAvailability === 'free' && repositoryError === null && (
                <p className="-mt-3 text-sm text-green-800">This name is free.</p>
              )}
              <fieldset>
                <legend className="font-medium text-slate-800">Visibility</legend>
                <div className="mt-2 space-y-2">
                  {[
                    { value: true, label: 'Private', detail: 'Only you can see it (recommended).' },
                    { value: false, label: 'Public', detail: 'Anyone on the internet can see it.' },
                  ].map((option) => (
                    <label key={option.label} className="flex cursor-pointer gap-3">
                      <input
                        type="radio"
                        name="visibility"
                        className="mt-1 h-5 w-5 shrink-0"
                        checked={isPrivate === option.value}
                        onChange={() => {
                          setIsPrivate(option.value);
                        }}
                      />
                      <span>
                        <span className="font-medium">{option.label}</span>:{' '}
                        <span className="text-slate-700">{option.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  On a free GitHub plan, branch protection is only available on public repositories.{' '}
                  <HelpLink page="projects#branch-protection">Learn more</HelpLink>
                </p>
              </fieldset>
            </>
          )}

          {refusal?.field === 'form' && <FieldError>{refusal.text}</FieldError>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create the project'}
            </Button>
            <Link
              to="/projects"
              className="rounded border border-slate-300 bg-white px-4 py-2 font-medium text-slate-800 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
