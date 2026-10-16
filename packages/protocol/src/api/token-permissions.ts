import { z } from 'zod';

/**
 * A permission of the GitHub token a refused push or download lacked (lot 3 steps F and K2), shown
 * as the token page names it: "Contents (Read and write)", "Workflows (Read and write)".
 */
export const PushPermission = z.enum(['contents', 'workflows']);
export type PushPermission = z.infer<typeof PushPermission>;

/** A push permission in the words of GitHub's token page (owner's note, lot 3 step E3). */
export const PUSH_PERMISSION_WORDS: Readonly<Record<PushPermission, string>> = {
  contents: 'Contents (Read and write)',
  workflows: 'Workflows (Read and write)',
};

/** GitHub's list of the account's fine-grained tokens, where a token's permissions change. */
export const GITHUB_TOKEN_LIST_URL = 'https://github.com/settings/personal-access-tokens';
