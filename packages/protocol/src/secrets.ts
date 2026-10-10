/** What a masked credential is replaced with. */
export const HIDDEN = '[hidden]';

/**
 * Credentials that could end up in a payload, a comment or a run's log by mistake: GitHub tokens
 * (classic and fine-grained), Anthropic keys and the Orchestrator's machine and run tokens (05,
 * sections 3.1 and 7; run tokens from lot 3 step H3). Shared by the server's event log, the
 * daemon's live log and every text sent to GitHub.
 */
const SECRET =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|o[mr]t_[A-Za-z0-9_-]{43})/g;

export function maskSecrets(text: string): string {
  return text.replace(SECRET, HIDDEN);
}
