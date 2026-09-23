import { GitHubStatusResponse } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../api';
import { Button, Card, ErrorMessage, Loading, PageHeader } from '../components/ui';
import { CreateTokenInstructions, PermissionResults, TokenForm } from '../github/token-form';
import { formatDate, formatDateTime, problemText } from '../github/text';
import { keys, queryClient, useGitHubStatus } from '../queries';

/** Settings (02, section 10): GitHub connection and limits so far. */
export function SettingsPage() {
  const github = useGitHubStatus();
  const status = github.data;
  return (
    <>
      <PageHeader title="Settings" help="settings" />
      <div className="space-y-3">
        <Link to="/settings/github" className="block">
          <Card className="hover:border-slate-400">
            <h2 className="font-semibold text-blue-700 underline">GitHub connection</h2>
            <p className="text-slate-700">
              {status?.connected
                ? `Connected to ${status.account}.`
                : 'Token status, expiry date, permissions check, replace the token.'}
            </p>
          </Card>
        </Link>
        <Link to="/settings/limits" className="block">
          <Card className="hover:border-slate-400">
            <h2 className="font-semibold text-blue-700 underline">Limits</h2>
            <p className="text-slate-700">
              Limits and timeouts: sessions, login, GitHub, tickets, and those of later versions.
            </p>
          </Card>
        </Link>
        {['Owner account', 'Backups'].map((title) => (
          <Card key={title}>
            <h2 className="font-semibold text-slate-900">{title}</h2>
            <p className="text-slate-700">Coming in a later version.</p>
          </Card>
        ))}
      </div>
    </>
  );
}

function checkErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'github_token_unreadable') {
      return 'The saved token cannot be read any more (the secret key changed). Enter the token again with "Replace the token".';
    }
    if (error.code === 'github_unreachable') {
      return 'GitHub could not be reached. Check the internet connection and try again.';
    }
  }
  return 'The check failed. Try again.';
}

/** Settings > GitHub connection: status, expiry date, check, replace token (02, section 10). */
export function GitHubSettingsPage() {
  const github = useGitHubStatus();
  const [replacing, setReplacing] = useState(false);
  const check = useMutation({
    mutationFn: () => api('POST', '/api/github/token/check', GitHubStatusResponse),
    onSuccess: (status) => {
      queryClient.setQueryData(keys.github, status);
    },
  });

  if (github.isPending) return <Loading />;
  if (github.isError)
    return <ErrorMessage>The GitHub connection could not be loaded.</ErrorMessage>;
  const status = github.data;

  const replaceForm = (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">
        {status.connected ? 'Replace the token' : 'Connect GitHub'}
      </h2>
      <CreateTokenInstructions />
      <TokenForm
        onSaved={(saved) => {
          queryClient.setQueryData(keys.github, saved);
          check.reset();
          setReplacing(false);
        }}
      />
      {status.connected && (
        <Button
          variant="secondary"
          onClick={() => {
            setReplacing(false);
          }}
        >
          Cancel
        </Button>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title="GitHub connection" help="github-token" />
      {!status.connected ? (
        replaceForm
      ) : (
        <div className="space-y-4">
          <Card>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
              <dt className="text-slate-600">GitHub account</dt>
              <dd className="font-medium">{status.account}</dd>
              <dt className="text-slate-600">Expiry date</dt>
              <dd className="font-medium">
                {status.expiresOn === null ? 'No expiry date' : formatDate(status.expiresOn)}
              </dd>
              <dt className="text-slate-600">Saved</dt>
              <dd>{formatDateTime(status.savedAt)}</dd>
              <dt className="text-slate-600">Last checked</dt>
              <dd>{formatDateTime(status.checkedAt)}</dd>
            </dl>
          </Card>
          {status.problems.length > 0 && (
            <Card className="space-y-2 border-red-300">
              <h2 className="text-lg font-semibold text-slate-900">Problems</h2>
              <ul className="list-disc space-y-1 pl-6">
                {status.problems.map((problem, index) => (
                  <li key={`${problem.type}-${String(index)}`}>{problemText(problem).title}</li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">Permissions</h2>
            <PermissionResults permissions={status.permissions} />
            {check.error && <ErrorMessage>{checkErrorText(check.error)}</ErrorMessage>}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  check.mutate();
                }}
                disabled={check.isPending}
              >
                {check.isPending ? 'Checking…' : 'Check again'}
              </Button>
              {!replacing && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setReplacing(true);
                  }}
                >
                  Replace the token
                </Button>
              )}
            </div>
          </Card>
          {replacing && replaceForm}
        </div>
      )}
    </>
  );
}
