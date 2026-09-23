import {
  GitHubStatusResponse,
  InspectGitHubTokenResponse,
  REQUIRED_GITHUB_PERMISSIONS,
  githubTokenCreationUrl,
  type PermissionCheck,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, ApiRequestError } from '../api';
import { Button, ErrorMessage, HelpLink, TextField } from '../components/ui';
import { accessLabel, resultLabel } from './text';

/**
 * The "Create the token on GitHub" button (02, section 3.1) and what to do on GitHub's form,
 * including the one setting the link cannot fill in: repository access.
 */
export function CreateTokenInstructions({ newTabHelp = false }: { newTabHelp?: boolean }) {
  return (
    <div className="space-y-3">
      <a
        href={githubTokenCreationUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
      >
        Create the token on GitHub
      </a>
      <ol className="list-decimal space-y-2 pl-6 text-slate-800">
        <li>
          Click the button above. GitHub opens its token form in a new tab, with the name, the
          expiry date and the permissions already filled in. Log in to GitHub if it asks.
        </li>
        <li>
          <strong>Under &quot;Repository access&quot;, choose &quot;All repositories&quot;.</strong>{' '}
          This is the only setting the button cannot fill in for you. It lets the Orchestrator work
          on the repositories it creates for you later; with any other choice, those new
          repositories would be out of its reach.
        </li>
        <li>
          Leave everything else as it is and click &quot;Generate token&quot; at the bottom of the
          page.
        </li>
        <li>
          Copy the token (it starts with <code>github_pat_</code>): GitHub shows it only once. Note
          the expiry date GitHub shows next to it.
        </li>
        <li>Come back here and paste it below.</li>
      </ol>
      <HelpLink page="github-token" newTab={newTabHelp}>
        More about the GitHub token
      </HelpLink>
    </div>
  );
}

function errorText(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'github_token_not_fine_grained':
      return 'This is not a fine-grained token: its text must start with github_pat_. Create it with the "Create the token on GitHub" button.';
    case 'github_token_invalid':
      return 'GitHub does not accept this token. Check that you copied all of it, or create a new one.';
    case 'github_unreachable':
      return 'GitHub could not be reached. Check the internet connection and try again.';
    case 'expiry_date_in_past':
      return 'The expiry date is in the past. Enter the date GitHub showed, or create a new token.';
    default:
      return error.message;
  }
}

/**
 * Paste a token, confirm its account and expiry date, then save it: the server checks it and
 * answers with the result of each permission (02, sections 3.1 and 3.2).
 */
export function TokenForm({ onSaved }: { onSaved: (status: GitHubStatusResponse) => void }) {
  const [token, setToken] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [noExpiry, setNoExpiry] = useState(false);

  const inspect = useMutation({
    mutationFn: () =>
      api('POST', '/api/github/token/inspect', InspectGitHubTokenResponse, { token }),
    onSuccess: (result) => {
      setExpiresOn(result.suggestedExpiresOn ?? '');
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api('PUT', '/api/github/token', GitHubStatusResponse, {
        token,
        expiresOn: noExpiry ? null : expiresOn,
      }),
    onSuccess: onSaved,
  });

  function restart() {
    inspect.reset();
    save.reset();
    setToken('');
    setExpiresOn('');
    setNoExpiry(false);
  }

  if (!inspect.data) {
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      inspect.mutate();
    };
    return (
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="GitHub token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
          required
        />
        {inspect.error && <ErrorMessage>{errorText(inspect.error)}</ErrorMessage>}
        <Button type="submit" disabled={inspect.isPending || token.trim() === ''}>
          {inspect.isPending ? 'Asking GitHub…' : 'Continue'}
        </Button>
      </form>
    );
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p>
        GitHub account: <strong>{inspect.data.account}</strong>
      </p>
      <TextField
        label="Expiry date"
        hint="The date GitHub showed when you created the token. The Orchestrator reminds you before it."
        type="date"
        value={noExpiry ? '' : expiresOn}
        disabled={noExpiry}
        onChange={(event) => {
          setExpiresOn(event.target.value);
        }}
        required={!noExpiry}
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={noExpiry}
          onChange={(event) => {
            setNoExpiry(event.target.checked);
          }}
        />
        No expiry date
      </label>
      {save.error && <ErrorMessage>{errorText(save.error)}</ErrorMessage>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending || (!noExpiry && expiresOn === '')}>
          {save.isPending ? 'Checking the token…' : 'Save and check'}
        </Button>
        <Button variant="secondary" onClick={restart} disabled={save.isPending}>
          Use another token
        </Button>
      </div>
    </form>
  );
}

const resultStyle = {
  ok: 'bg-green-100 text-green-900',
  missing: 'bg-red-100 text-red-900',
  could_not_verify: 'bg-amber-100 text-amber-900',
} as const;

/** The result of each required permission, in the order of GitHub's form (02, section 3.2). */
export function PermissionResults({ permissions }: { permissions: PermissionCheck[] }) {
  return (
    <ul aria-label="Permissions" className="divide-y divide-slate-200">
      {REQUIRED_GITHUB_PERMISSIONS.map(({ permission, access, label }) => {
        const check = permissions.find((candidate) => candidate.permission === permission);
        const result = check?.result ?? 'could_not_verify';
        return (
          <li key={permission} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <div>
              <span className="font-medium">{label}</span>{' '}
              <span className="text-sm text-slate-600">({accessLabel(access)})</span>
              {check?.reason && result !== 'ok' && (
                <span className="block text-sm text-slate-600">{check.reason}</span>
              )}
            </div>
            <span className={`rounded px-2 py-0.5 text-sm font-medium ${resultStyle[result]}`}>
              {resultLabel[result]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
