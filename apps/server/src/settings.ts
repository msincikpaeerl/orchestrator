/**
 * Settings of the server (04, section 8: every limit and timeout is a setting with a default).
 * Only the defaults exist so far; the Settings screen that edits them comes with a later lot.
 */
export interface Settings {
  /** How long a login lasts before the owner must log in again. */
  sessionLifetimeDays: number;
  /** "Needs you" warns this many days before the GitHub token's expiry date (02, section 3.1). */
  githubTokenExpiryWarningDays: number;
  /** Time allowed for one GitHub API request. */
  githubRequestTimeoutSeconds: number;
}

export const defaultSettings: Readonly<Settings> = {
  sessionLifetimeDays: 30,
  githubTokenExpiryWarningDays: 14,
  githubRequestTimeoutSeconds: 15,
};
