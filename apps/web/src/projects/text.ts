import type {
  ApiErrorCode,
  BranchProtection,
  HarnessElement,
  ProjectKind,
  SetupStep,
} from '@orchestrator/protocol';
import { ApiRequestError } from '../api';
import { refusalText as plainRefusal } from '../refusals';

export { sentence } from '../refusals';

export const kindLabel: Record<ProjectKind, string> = {
  web_app: 'Web app',
  website: 'Website',
  android_app: 'Android app',
};

/** The steps of the repository setup, as the project page lists them. */
export const stepLabel: Record<SetupStep, string> = {
  repository: 'Create the GitHub repository',
  skeleton: 'Add the starting files',
  branch_protection: 'Protect the default branch',
  harness: 'Look for the harness elements',
};

/** Harness elements (08, section 3.4), with the section of the Projects help page for each. */
export const harnessElement: Record<HarnessElement, { label: string; help: string }> = {
  claude_md: { label: 'CLAUDE.md', help: 'projects#claudemd' },
  user_docs: { label: 'User documentation (docs/user/)', help: 'projects#user-documentation' },
  dev_docs: {
    label: 'Developer documentation (docs/dev/)',
    help: 'projects#developer-documentation',
  },
  adrs: { label: 'Architecture decisions (docs/adr/)', help: 'projects#architecture-decisions' },
  ci_workflow: { label: 'CI workflow (.github/workflows/)', help: 'projects#ci-workflow' },
};

export const branchProtectionLabel: Record<BranchProtection, string> = {
  applied: 'Applied',
  not_available: 'Not available on your GitHub plan',
  failed: 'Failed',
  not_applied: 'Not applied: a linked repository is never changed',
};

/**
 * The key suggested from a project's name (01, section 3.1): the initials of its words, or the
 * first four letters of a single word. Empty when the name has too few letters.
 */
export function suggestKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const key = words.length >= 2 ? words.map((word) => word.charAt(0)).join('') : (words[0] ?? '');
  return key.length >= 2 ? key.slice(0, words.length >= 2 ? 6 : 4) : '';
}

export function repositoryUrl(repository: { owner: string; name: string }): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** The form field a refusal is about, so it is shown next to that field. */
export type ErrorField = 'key' | 'repository' | 'form';

const fieldOf: Partial<Record<ApiErrorCode, ErrorField>> = {
  project_key_taken: 'key',
  repository_name_taken: 'repository',
  repository_not_found: 'repository',
  repository_archived: 'repository',
  repository_already_linked: 'repository',
};

/** A refusal of a project screen in plain words (see `refusals.ts`), and the field it is about. */
export function refusalText(error: unknown): { field: ErrorField; text: string } {
  const field =
    error instanceof ApiRequestError && error.code !== 'unexpected'
      ? fieldOf[error.code]
      : undefined;
  return { field: field ?? 'form', text: plainRefusal(error) };
}
