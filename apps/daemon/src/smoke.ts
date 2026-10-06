// The daemon's own code that the owner's GitHub smoke script runs on the real GitHub
// (tools/smoke/github-smoke.sh, lot 3 plan, step E): the workspace's fetch and push in an
// isolated repository (ADR 0034), exactly as a run uses them, never a copy.
export { GIT_MINIMUM } from './doctor.js';
export { findExecutable } from './exec.js';
export { Git } from './git.js';
export { daemonPaths } from './paths.js';
export { TrustRegistry } from './trust.js';
export { Workspaces } from './workspace.js';
export type { CredentialAnswer } from './credentials.js';
