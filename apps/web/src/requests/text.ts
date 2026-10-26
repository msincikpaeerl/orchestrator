import type { RequestStatus } from '@orchestrator/protocol';

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
