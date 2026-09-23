import type {
  BranchProtection,
  HarnessElement,
  ProjectKind,
  SetupStep,
} from '@orchestrator/protocol';
import { ApiRequestError } from '../api';

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

/** The text ending with a full stop, whether or not it already had one. */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function repositoryUrl(repository: { owner: string; name: string }): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** The form field a refusal is about, so it is shown next to that field. */
export type ErrorField = 'key' | 'repository' | 'form';

/**
 * A refusal of the API in plain words, and the field it is about. Never shows the code: every
 * refusal a project screen can receive has its own text.
 */
export function refusalText(error: unknown): { field: ErrorField; text: string } {
  if (!(error instanceof ApiRequestError)) {
    return { field: 'form', text: 'Something went wrong. Try again.' };
  }
  switch (error.code) {
    case 'invalid_request':
      return { field: 'form', text: 'Some fields are not valid. Check them and try again.' };
    case 'project_key_taken':
      return {
        field: 'key',
        text: 'Another project already uses this key (archived projects count too). Choose another key.',
      };
    case 'repository_name_taken':
      return {
        field: 'repository',
        text: 'A repository with this name already exists on your GitHub account. Choose another name, or link that repository instead.',
      };
    case 'repository_not_found':
      return {
        field: 'repository',
        text: 'This repository is no longer on your GitHub account. Choose another one.',
      };
    case 'repository_archived':
      return {
        field: 'repository',
        text: 'This repository is archived on GitHub. Unarchive it on GitHub first, or choose another one.',
      };
    case 'repository_already_linked':
      return {
        field: 'repository',
        text: 'This repository is already linked to another project. Choose another one.',
      };
    case 'github_request_failed':
      return { field: 'form', text: `GitHub refused the request. ${sentence(error.message)}` };
    case 'github_unreachable':
      return {
        field: 'form',
        text: 'GitHub could not be reached. Check the internet connection and try again.',
      };
    case 'github_not_connected':
      return {
        field: 'form',
        text: 'GitHub is not connected. Connect it in Settings > GitHub connection first.',
      };
    case 'github_token_unreadable':
      return {
        field: 'form',
        text: 'The saved GitHub token cannot be read any more (the secret key changed). Enter it again in Settings > GitHub connection.',
      };
    case 'project_not_found':
      return { field: 'form', text: 'This project does not exist.' };
    case 'project_archived':
      return { field: 'form', text: 'This project is archived. Unarchive it first.' };
    case 'project_not_archived':
      return { field: 'form', text: 'This project is not archived any more.' };
    case 'project_setup_in_progress':
      return {
        field: 'form',
        text: 'The repository setup is running. Wait until it is finished, then try again.',
      };
    case 'project_setup_not_failed':
      return { field: 'form', text: 'The setup has not failed any more: nothing to try again.' };
    case 'project_not_linked':
      return {
        field: 'form',
        text: 'Harness elements are only checked for linked repositories.',
      };
    case 'project_not_ready':
      return {
        field: 'form',
        text: 'The repository setup is not finished. Use Try again first.',
      };
    case 'unexpected':
      return error.status === 0
        ? { field: 'form', text: 'The Orchestrator could not be reached. Try again.' }
        : { field: 'form', text: 'Something went wrong. Try again.' };
    default:
      return { field: 'form', text: 'Something went wrong. Try again.' };
  }
}
