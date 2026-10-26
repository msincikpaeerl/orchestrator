import { z } from 'zod';
import { ProjectKey } from './projects.js';
import { Comment } from './tickets.js';

// Requests (01, section 3.2; 02, section 5; lot 5 step D1): the owner's free text, for a project
// or for a new one, which the Project Manager turns into a plan.

/** A request's states (01, section 3.2). Nothing changes them before step E2's planning runs. */
export const RequestStatus = z.enum(['open', 'planning', 'plan_proposed', 'closed']);
export type RequestStatus = z.infer<typeof RequestStatus>;

/** One sequence for every request, from 1: "Request 7", `/requests/7`. */
export const RequestNumber = z.int().min(1).max(2_147_483_647);

/**
 * How much of a request's first line the screens show as its title (owner's answer 8, lot 5 step
 * D): a display constant, not a setting (04, section 8).
 */
export const REQUEST_LINE_MAX_LENGTH = 120;

/** The request's first line with text, cut at `REQUEST_LINE_MAX_LENGTH` with an ellipsis. */
export function requestLine(body: string): string {
  const line =
    body
      .split('\n')
      .map((each) => each.trim())
      .find((each) => each !== '') ?? '';
  return line.length > REQUEST_LINE_MAX_LENGTH
    ? `${line.slice(0, REQUEST_LINE_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}

/** The project a request is for; null when it asks for a new project. */
export const RequestProject = z.object({ key: ProjectKey, name: z.string() }).nullable();
export type RequestProject = z.infer<typeof RequestProject>;

export const RequestSummary = z.object({
  number: RequestNumber,
  /** The first line, as `requestLine` cuts it. */
  line: z.string(),
  status: RequestStatus,
  project: RequestProject,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RequestSummary = z.infer<typeof RequestSummary>;

/** `GET /api/requests`: every request, newest first (02, section 5.1). */
export const RequestListResponse = z.object({ requests: z.array(RequestSummary) });
export type RequestListResponse = z.infer<typeof RequestListResponse>;

/** `GET /api/requests/:number` (02, section 5.3): the text and the conversation, oldest first. */
export const RequestDetail = RequestSummary.extend({
  /** Markdown, rendered sanitized (01, section 3.5). */
  body: z.string(),
  comments: z.array(Comment),
});
export type RequestDetail = z.infer<typeof RequestDetail>;

/**
 * `POST /api/requests` (02, section 5.2): the text, and the key of a project not archived, or
 * null for a new project. Its length limit is **Longest ticket description**, checked by the
 * server (owner's answer 7, lot 5 step D).
 */
export const CreateRequestRequest = z.strictObject({
  body: z.string().trim().min(1, 'cannot be empty'),
  project: ProjectKey.nullable(),
});
export type CreateRequestRequest = z.infer<typeof CreateRequestRequest>;
