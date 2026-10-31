import type { Comment } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import {
  planningStoppedHeading,
  planningStoppedText,
  requestCommentAuthor,
  requestOpenQuestion,
  requestQuestionHeading,
} from './text';

describe('requestQuestionHeading (owner answer 5, lot 5 step D2b)', () => {
  it('names the request, its project and its first line', () => {
    expect(
      requestQuestionHeading({
        number: 7,
        line: 'A contact form',
        project: { key: 'TESTB', name: 'Test B' },
      }),
    ).toBe('Question on request 7 (TESTB): A contact form');
  });

  it('says "new project" for a request with none', () => {
    expect(requestQuestionHeading({ number: 8, line: 'A shop', project: null })).toBe(
      'Question on request 8 (new project): A shop',
    );
  });
});

const comment = (id: string, kind: Comment['kind'], answers: string | null = null): Comment => ({
  id,
  author: kind === 'question' ? 'agent' : 'owner',
  agent: null,
  kind,
  body: kind,
  answers,
  createdAt: '2026-10-28T10:00:00.000Z',
});

const Q1 = '00000000-0000-4000-8000-000000000001';
const Q2 = '00000000-0000-4000-8000-000000000002';
const A1 = '00000000-0000-4000-8000-000000000003';

const RUN = '00000000-0000-4000-8000-000000000009';
const ENDED_RUN = '00000000-0000-4000-8000-000000000008';
const asked = (id: string, runId: string): Comment => ({
  ...comment(id, 'question'),
  agent: { profile: { key: 'pm', name: 'Project Manager' }, runId },
});
const active = { id: RUN, status: 'waiting_human' as const };

describe('requestOpenQuestion (owner answer 3, lot 5 step D2b; answer 8, step E2)', () => {
  it('is the latest question while it has no answer, live while its run is active', () => {
    const comments = [asked(Q1, RUN), comment(A1, 'answer', Q1), asked(Q2, RUN)];
    expect(requestOpenQuestion({ status: 'planning', comments, run: active })).toEqual({
      question: comments[2],
      live: true,
    });
    expect(
      requestOpenQuestion({ status: 'planning', comments: comments.slice(0, 2), run: active }),
    ).toBeNull();
    expect(requestOpenQuestion({ status: 'planning', comments: [], run: active })).toBeNull();
  });

  it('keeps a question left by a run that ended, not live, until a closed request', () => {
    const comments = [asked(Q1, ENDED_RUN)];
    expect(requestOpenQuestion({ status: 'open', comments, run: null })).toEqual({
      question: comments[0],
      live: false,
    });
    // Another planning run started meanwhile: the question is still not its own.
    expect(requestOpenQuestion({ status: 'planning', comments, run: active })?.live).toBe(false);
    expect(requestOpenQuestion({ status: 'closed', comments, run: null })).toBeNull();
  });
});

describe('Planning stopped (owner answer 7, lot 5 step E2)', () => {
  it('names the request and its project, or a new project', () => {
    expect(
      planningStoppedHeading({ number: 7, line: 'A shop', project: { key: 'TESTB', name: 'B' } }),
    ).toBe('Planning stopped for request 7 (TESTB): A shop');
    expect(planningStoppedHeading({ number: 8, line: 'A shop', project: null })).toBe(
      'Planning stopped for request 8 (new project): A shop',
    );
  });

  it('says why, and what Try again does', () => {
    const at = '2026-10-30T10:00:00.000Z';
    expect(planningStoppedText({ cause: 'failed_attempts', count: 2, limit: 2, at })).toBe(
      'Its planning failed 2 times, as many as Failed attempts before asking you allows (2). Use Try again to let the Project Manager plan it again.',
    );
    expect(planningStoppedText({ cause: 'failed_attempts', count: 1, limit: 1, at })).toMatch(
      /^Its planning failed once, as many as/,
    );
    expect(planningStoppedText({ cause: 'stop_run', runId: RUN, at })).toMatch(
      /^You stopped its planning run at .+\. Use Try again to let the Project Manager plan it again\.$/,
    );
  });
});

describe('requestCommentAuthor', () => {
  it("marks the Project Manager's questions and the owner's answers", () => {
    expect(requestCommentAuthor(comment(Q1, 'question'))).toBe('Question');
    expect(requestCommentAuthor(comment(A1, 'answer', Q1))).toBe('Your answer');
    expect(requestCommentAuthor(comment(Q2, 'note'))).toBe('You');
  });
});
