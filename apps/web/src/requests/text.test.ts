import type { Comment } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { requestCommentAuthor, requestOpenQuestion, requestQuestionHeading } from './text';

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

describe('requestOpenQuestion (owner answer 3, lot 5 step D2b)', () => {
  it('is the latest question of a planning request, while it has no answer', () => {
    const asked = [comment(Q1, 'question'), comment(A1, 'answer', Q1), comment(Q2, 'question')];
    expect(requestOpenQuestion({ status: 'planning', comments: asked })?.id).toBe(Q2);
    expect(requestOpenQuestion({ status: 'planning', comments: asked.slice(0, 2) })).toBeNull();
    expect(requestOpenQuestion({ status: 'planning', comments: [] })).toBeNull();
  });

  it('is none once the request is no longer planning', () => {
    expect(requestOpenQuestion({ status: 'open', comments: [comment(Q1, 'question')] })).toBeNull();
  });
});

describe('requestCommentAuthor', () => {
  it("marks the Project Manager's questions and the owner's answers", () => {
    expect(requestCommentAuthor(comment(Q1, 'question'))).toBe('Question');
    expect(requestCommentAuthor(comment(A1, 'answer', Q1))).toBe('Your answer');
    expect(requestCommentAuthor(comment(Q2, 'note'))).toBe('You');
  });
});
