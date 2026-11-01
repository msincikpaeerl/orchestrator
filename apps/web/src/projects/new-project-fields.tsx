import {
  AvailabilityResponse,
  defaultRequiredCapabilities,
  ProjectKey,
  RepositoryName,
  type ProjectKind,
} from '@orchestrator/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { HelpLink, TextField } from '../components/ui';
import { kindHint } from './text';

// The fields of a new project with a new repository, shared by the new project page (02, section
// 6.2) and the approval form of a plan creating a project (02, section 5.3; lot 5 step G): the
// key and the repository name checked free as they are typed, and the visibility.

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
export function useAvailability(field: 'key' | 'repositoryName', value: string, enabled: boolean) {
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

/** What is wrong with the key, if anything: the server's refusal first. */
export function keyError(input: {
  key: string;
  availability: string | undefined;
  refusal: string | null;
  submitted: boolean;
}): string | null {
  if (input.refusal !== null) return input.refusal;
  if (input.key !== '' && !ProjectKey.safeParse(input.key).success) {
    return 'Use 2 to 6 capital letters, for example WEB.';
  }
  if (input.availability === 'taken') {
    return 'Another project already uses this key (archived projects count too). Choose another key.';
  }
  return input.submitted && input.key === '' ? 'Enter a key.' : null;
}

/** What is wrong with a new repository's name, if anything: the server's refusal first. */
export function repositoryNameError(input: {
  name: string;
  availability: string | undefined;
  refusal: string | null;
  submitted: boolean;
  /** The new project page offers to link an existing repository instead. */
  linkOffered: boolean;
}): string | null {
  if (input.refusal !== null) return input.refusal;
  if (input.name !== '' && !RepositoryName.safeParse(input.name).success) {
    return 'Use only letters, digits, “.”, “-” and “_”.';
  }
  if (input.availability === 'taken') {
    return `A repository with this name already exists on your GitHub account. Choose another name${input.linkOffered ? ', or link that repository instead' : ''}.`;
  }
  return input.submitted && input.name === '' ? 'Enter a repository name.' : null;
}

export function KeyField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      label="Key"
      hint="2 to 6 capital letters. It starts every ticket number (for example WEB-12) and cannot be changed later."
      value={value}
      maxLength={6}
      autoCapitalize="characters"
      autoComplete="off"
      error={error}
      onChange={(event) => {
        onChange(event.target.value.toUpperCase());
      }}
    />
  );
}

export function RepositoryNameField({
  value,
  error,
  free,
  onChange,
}: {
  value: string;
  error: string | null;
  free: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <TextField
        label="Repository name"
        hint="The name of the new repository on your GitHub account, made from the project name. You can change it."
        value={value}
        maxLength={100}
        autoCapitalize="none"
        autoComplete="off"
        error={error}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {free && error === null && <p className="-mt-3 text-sm text-green-800">This name is free.</p>}
    </>
  );
}

export function VisibilityField({
  isPrivate,
  onChange,
}: {
  isPrivate: boolean;
  onChange: (isPrivate: boolean) => void;
}) {
  return (
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
                onChange(option.value);
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
  );
}

/** The kind's hint, with the link to Help > Machines > "Browser tests" when it requires them. */
export function KindHint({ kind }: { kind: ProjectKind }) {
  return (
    <>
      {kindHint(kind)}
      {defaultRequiredCapabilities(kind).length > 0 && (
        <>
          {' '}
          <HelpLink page="machines#browser-tests">Browser tests</HelpLink>
        </>
      )}
    </>
  );
}
