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
  /**
   * Allowed difference between the server's clock and GitHub's, when deciding whether a
   * repository was created by an interrupted setup attempt (08, section 3.1).
   */
  githubClockToleranceSeconds: number;
  /** Failed logins allowed for one username or one client address before a delay applies. */
  loginFailuresBeforeDelay: number;
  /** Delay after the first failure over the limit; it doubles with each further failure. */
  loginFirstDelaySeconds: number;
  /** Longest delay between login attempts. */
  loginMaxDelaySeconds: number;
  /** Failed logins older than this are forgotten. */
  loginFailureMemoryMinutes: number;
}

export const defaultSettings: Readonly<Settings> = {
  sessionLifetimeDays: 30,
  githubTokenExpiryWarningDays: 14,
  githubRequestTimeoutSeconds: 15,
  githubClockToleranceSeconds: 120,
  loginFailuresBeforeDelay: 5,
  loginFirstDelaySeconds: 10,
  loginMaxDelaySeconds: 15 * 60,
  loginFailureMemoryMinutes: 60,
};
