import { z } from 'zod';
import { RepositoryName } from '../api/projects.js';
import { McpError } from '../mcp/errors.js';
import { McpToolName } from '../mcp/tools.js';
import { requiredText } from '../text-limits.js';
import { message } from './envelope.js';
import { RUN_TOKEN_MAX_CHARACTERS, SUBMISSION_REPORT_MAX_BYTES, encodedBytes } from './budgets.js';
import { BranchReport, ChangedFiles, PushResult, RepositoryOwner } from './git.js';
import { RunId } from './runs.js';

/** A JSON object: a tool's input or output, checked against the tool's own schema by the server. */
const JsonObject = z.record(z.string(), z.unknown());

/**
 * Facts about the worktree, collected by the daemon when it forwards a `ticket_submit`, never
 * from a cached state. The server runs every submission check on them (05, section 4.9).
 */
export const WorkspaceFacts = z.object({
  /** No uncommitted changes, untracked files included. */
  clean: z.boolean(),
  branch: BranchReport,
  /**
   * The push made before forwarding the call, when the worktree was clean with commits ahead
   * (protocol 2); null when none was tried. Absent from a protocol 1 daemon, which never pushes.
   */
  push: PushResult.nullable().default(null),
  /**
   * Paths changed on the branch against the base branch, relative to the worktree root, for the
   * check that every path the report lists is changed (04, section 3.1; protocol 2). Null when not
   * read: absent from a protocol 1 daemon.
   */
  changedFiles: ChangedFiles.nullable().default(null),
});
export type WorkspaceFacts = z.infer<typeof WorkspaceFacts>;

const RunToken = requiredText(RUN_TOKEN_MAX_CHARACTERS);

/** `mcp.call`: a tool call from an agent, answered by `mcp.result` with the same id (06, section 1). */
export const McpCall = message(
  'mcp.call',
  z.discriminatedUnion('tool', [
    z.object({
      tool: z.literal('ticket_submit'),
      runToken: RunToken,
      /** The DoD report, refused by the daemon above its budget (04, section 8; lot 3 step F). */
      input: JsonObject.refine(
        (input) => encodedBytes(input) <= SUBMISSION_REPORT_MAX_BYTES,
        `at most ${String(SUBMISSION_REPORT_MAX_BYTES)} bytes`,
      ),
      workspace: WorkspaceFacts,
    }),
    z.object({
      tool: McpToolName.exclude(['ticket_submit']),
      runToken: RunToken,
      input: JsonObject,
    }),
  ]),
);
export type McpCall = z.infer<typeof McpCall>;

/** `mcp.result`: the tool's output, or its error, relayed to the agent as is. */
export const McpResult = message(
  'mcp.result',
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), output: JsonObject }),
    z.object({ ok: z.literal(false), error: McpError }),
  ]),
);
export type McpResult = z.infer<typeof McpResult>;

/**
 * `git.credential_request`: the credential for one Git command on the repository of an active or
 * ending run (05, section 7). `push` from protocol 2, never for a `review` run.
 */
export const GitCredentialRequest = message(
  'git.credential_request',
  z.object({
    runId: RunId,
    repository: z.object({ owner: RepositoryOwner, name: RepositoryName }),
    command: z.enum(['fetch', 'push']),
  }),
);
export type GitCredentialRequest = z.infer<typeof GitCredentialRequest>;

/**
 * `git.credential`: the answer, with the request's id. The daemon keeps the credential in memory
 * for that one command only; it is never logged or written anywhere (05, section 7).
 */
export const GitCredential = message(
  'git.credential',
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), username: requiredText(), password: requiredText() }),
    z.object({ ok: z.literal(false), message: requiredText() }),
  ]),
);
export type GitCredential = z.infer<typeof GitCredential>;
