import type { Comment, RequestDetail, RequestProject, RequestStatus } from '@orchestrator/protocol';

/** The request's page: `/requests/7`. */
export function requestPath(number: number): string {
  return `/requests/${String(number)}`;
}

/** How screens name a request (owner's answer 6, lot 5 step D). */
export function requestName(number: number): string {
  return `Request ${String(number)}`;
}

/** A request's state in words (01, section 3.2). */
export const requestStatusLabel: Record<RequestStatus, string> = {
  open: 'Open',
  planning: 'Planning',
  plan_proposed: 'Plan to review',
  closed: 'Closed',
};

/**
 * Needs you's heading of a planning run's question (owner's answer 5, lot 5 step D2b): "Question
 * on request 7 (TESTB): <first line>", "(new project)" for a request with no project.
 */
export function requestQuestionHeading(request: {
  number: number;
  line: string;
  project: RequestProject;
}): string {
  const project = request.project === null ? 'new project' : request.project.key;
  return `Question on request ${String(request.number)} (${project}): ${request.line}`;
}

/**
 * The planning run's question waiting for the owner's answer (owner's answer 3, lot 5 step D2b),
 * as a ticket's: the request is `planning` and its latest question has no answer yet.
 */
export function requestOpenQuestion(
  request: Pick<RequestDetail, 'status' | 'comments'>,
): Comment | null {
  if (request.status !== 'planning') return null;
  const question = request.comments.filter((comment) => comment.kind === 'question').at(-1);
  if (!question) return null;
  return request.comments.some((comment) => comment.answers === question.id) ? null : question;
}

/** Who wrote a comment of the conversation, a question and an answer named as such. */
export function requestCommentAuthor(comment: Comment): string {
  const agent = comment.agent?.profile.name;
  if (comment.kind === 'question') return agent ? `Question from agent ${agent}` : 'Question';
  if (comment.kind === 'answer') return 'Your answer';
  if (comment.author === 'owner') return 'You';
  return agent ? `Agent ${agent}` : 'The Orchestrator';
}
