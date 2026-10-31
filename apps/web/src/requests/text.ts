import type {
  Comment,
  RequestDetail,
  RequestProject,
  RequestStatus,
  RequestStop,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

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
 * A request named with its project and first line: "Request 7 (TESTB): <first line>", "(new
 * project)" for none; a paused planning run's subject in Needs you (owner's answer 4, lot 5 step
 * E2b).
 */
export function requestSubjectText(request: {
  number: number;
  line: string;
  project: RequestProject;
}): string {
  const project = request.project === null ? 'new project' : request.project.key;
  return `${requestName(request.number)} (${project}): ${request.line}`;
}

/**
 * A request's line in Activity > Queue (owner's answer 10, lot 5 step E2): "Request 7 (TESTB) ·
 * <first line>", "(new project)" for none.
 */
export function requestQueueTitle(request: {
  number: number;
  line: string;
  projectKey: string | null;
}): string {
  return `${requestName(request.number)} (${request.projectKey ?? 'new project'}) · ${request.line}`;
}

/**
 * The request's latest question with no answer (owner's answer 3, lot 5 step D2b; answer 8, step
 * E2): `live` while the planning run that asked it is active, so the answer reaches it; else that
 * run ended, and the answer is kept for the next planning run. None on a closed request.
 */
export function requestOpenQuestion(
  request: Pick<RequestDetail, 'status' | 'comments' | 'run'>,
): { question: Comment; live: boolean } | null {
  if (request.status === 'closed') return null;
  const question = request.comments.filter((comment) => comment.kind === 'question').at(-1);
  if (!question) return null;
  if (request.comments.some((comment) => comment.answers === question.id)) return null;
  const live =
    request.status === 'planning' &&
    request.run !== null &&
    question.agent?.runId === request.run.id;
  return { question, live };
}

/** The sentence under a question whose planning run ended (owner's answer 8, lot 5 step E2). */
export const ENDED_QUESTION_TEXT =
  'Its planning run ended: your answer is kept and the next planning run reads it.';

/**
 * "Planning stopped" (owner's answer 7, lot 5 step E2), in Needs you and on the request page:
 * the heading, why, and what Try again does.
 */
export function planningStoppedHeading(request: {
  number: number;
  line: string;
  project: RequestProject;
}): string {
  const project = request.project === null ? 'new project' : request.project.key;
  return `Planning stopped for request ${String(request.number)} (${project}): ${request.line}`;
}

export function planningStoppedText(stop: RequestStop): string {
  const why =
    stop.cause === 'stop_run'
      ? `You stopped its planning run at ${formatDateTime(stop.at)}.`
      : `Its planning failed ${stop.count === 1 ? 'once' : `${String(stop.count)} times`}, ${stop.count > stop.limit ? 'more than' : 'as many as'} Failed attempts before asking you allows (${String(stop.limit)}).`;
  return `${why} Use Try again to let the Project Manager plan it again.`;
}

/** Who wrote a comment of the conversation, a question and an answer named as such. */
export function requestCommentAuthor(comment: Comment): string {
  const agent = comment.agent?.profile.name;
  if (comment.kind === 'question') return agent ? `Question from agent ${agent}` : 'Question';
  if (comment.kind === 'answer') return 'Your answer';
  if (comment.author === 'owner') return 'You';
  return agent ? `Agent ${agent}` : 'The Orchestrator';
}
