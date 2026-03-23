// ---------------------------------------------------------------------------
// Unit Tests — Per-Turn State Manager
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import type { InterviewSession } from '../services/session';
import {
  applyQuestionAsked,
  applyResponseSubmitted,
  applyQuestionSkipped,
  applyFollowupTriggered,
  buildTurnContext,
  formatTurnContext,
  type TemplateQuestionRef,
} from '../services/stateManager';

// --- Helpers ---

function makeSession(
  overrides?: Partial<InterviewSession>,
): InterviewSession {
  return {
    interviewId: 'interview-1',
    templateId: 'template-1',
    userId: 'user-1',
    conversationHistory: [],
    questionsAsked: [],
    questionsSkipped: [],
    bucketsCovered: { process: 0, technology: 0, culture: 0 },
    requiredRemaining: ['q1', 'q2', 'q3'],
    optionalRemaining: ['q4', 'q5'],
    triggeredFollowups: [],
    currentTranscriptBuffer: '',
    currentDrafts: [],
    totalExpectedQuestions: 5,
    questionsCompleted: 0,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    idleWarningShown: false,
    isStreaming: false,
    currentTurnLlmText: null,
    ...overrides,
  };
}

function makeQuestionMap(
  entries: Array<{
    questionId: string;
    text: string;
    categoryBucket: string;
    followupTriggers?: Array<{
      condition: string;
      followupQuestionId: string;
    }>;
  }>,
): Map<string, TemplateQuestionRef> {
  const map = new Map<string, TemplateQuestionRef>();
  for (const e of entries) {
    map.set(e.questionId, {
      questionId: e.questionId,
      text: e.text,
      categoryBucket: e.categoryBucket,
      followupTriggers: e.followupTriggers ?? [],
    });
  }
  return map;
}

// --- applyQuestionAsked ---

describe('applyQuestionAsked', () => {
  it('adds questionId to questionsAsked', () => {
    const patch = applyQuestionAsked(makeSession(), 'q1', 'process');
    expect(patch.questionsAsked).toEqual(['q1']);
  });

  it('appends to existing questionsAsked', () => {
    const session = makeSession({ questionsAsked: ['q1'] });
    const patch = applyQuestionAsked(session, 'q2', 'technology');
    expect(patch.questionsAsked).toEqual(['q1', 'q2']);
  });

  it('increments bucket coverage', () => {
    const patch = applyQuestionAsked(makeSession(), 'q1', 'process');
    expect(patch.bucketsCovered!.process).toBe(1);
    expect(patch.bucketsCovered!.technology).toBe(0);
  });

  it('initializes bucket count for new bucket', () => {
    const session = makeSession({ bucketsCovered: {} });
    const patch = applyQuestionAsked(session, 'q1', 'newbucket');
    expect(patch.bucketsCovered!.newbucket).toBe(1);
  });

  it('removes from requiredRemaining', () => {
    const patch = applyQuestionAsked(makeSession(), 'q1', 'process');
    expect(patch.requiredRemaining).toEqual(['q2', 'q3']);
  });

  it('removes from optionalRemaining if present', () => {
    const patch = applyQuestionAsked(makeSession(), 'q4', 'technology');
    expect(patch.optionalRemaining).toEqual(['q5']);
  });

  it('does not mutate original session', () => {
    const session = makeSession();
    const originalAsked = [...session.questionsAsked];
    const originalBuckets = { ...session.bucketsCovered };
    applyQuestionAsked(session, 'q1', 'process');
    expect(session.questionsAsked).toEqual(originalAsked);
    expect(session.bucketsCovered).toEqual(originalBuckets);
  });

  it('handles question not in any remaining list (follow-up)', () => {
    const patch = applyQuestionAsked(makeSession(), 'q-followup', 'process');
    expect(patch.questionsAsked).toContain('q-followup');
    expect(patch.requiredRemaining).toEqual(['q1', 'q2', 'q3']);
    expect(patch.optionalRemaining).toEqual(['q4', 'q5']);
  });
});

// --- applyResponseSubmitted ---

describe('applyResponseSubmitted', () => {
  it('increments questionsCompleted', () => {
    const session = makeSession({ questionsCompleted: 2 });
    const patch = applyResponseSubmitted(session, '2026-01-01T01:00:00.000Z');
    expect(patch.questionsCompleted).toBe(3);
  });

  it('clears transcript buffer', () => {
    const session = makeSession({ currentTranscriptBuffer: 'partial text' });
    const patch = applyResponseSubmitted(session, '2026-01-01T01:00:00.000Z');
    expect(patch.currentTranscriptBuffer).toBe('');
  });

  it('clears drafts', () => {
    const session = makeSession({
      currentDrafts: [
        {
          content: 'draft text',
          inputMode: 'text',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const patch = applyResponseSubmitted(session, '2026-01-01T01:00:00.000Z');
    expect(patch.currentDrafts).toEqual([]);
  });

  it('updates lastActivityAt with provided timestamp', () => {
    const now = '2026-03-15T12:30:00.000Z';
    const patch = applyResponseSubmitted(makeSession(), now);
    expect(patch.lastActivityAt).toBe(now);
  });

  it('uses current time when no timestamp provided', () => {
    const before = new Date().toISOString();
    const patch = applyResponseSubmitted(makeSession());
    const after = new Date().toISOString();
    expect(patch.lastActivityAt! >= before).toBe(true);
    expect(patch.lastActivityAt! <= after).toBe(true);
  });

  it('resets idleWarningShown', () => {
    const session = makeSession({ idleWarningShown: true });
    const patch = applyResponseSubmitted(session, '2026-01-01T01:00:00.000Z');
    expect(patch.idleWarningShown).toBe(false);
  });
});

// --- applyQuestionSkipped ---

describe('applyQuestionSkipped', () => {
  it('adds to questionsSkipped', () => {
    const patch = applyQuestionSkipped(
      makeSession(),
      'q1',
      'process',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.questionsSkipped).toEqual(['q1']);
  });

  it('appends to existing questionsSkipped', () => {
    const session = makeSession({ questionsSkipped: ['q-prev'] });
    const patch = applyQuestionSkipped(
      session,
      'q1',
      'process',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.questionsSkipped).toEqual(['q-prev', 'q1']);
  });

  it('increments bucket coverage', () => {
    const patch = applyQuestionSkipped(
      makeSession(),
      'q1',
      'process',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.bucketsCovered!.process).toBe(1);
  });

  it('removes from requiredRemaining', () => {
    const patch = applyQuestionSkipped(
      makeSession(),
      'q2',
      'technology',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.requiredRemaining).not.toContain('q2');
    expect(patch.requiredRemaining).toContain('q1');
  });

  it('removes from optionalRemaining if present', () => {
    const patch = applyQuestionSkipped(
      makeSession(),
      'q4',
      'technology',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.optionalRemaining).not.toContain('q4');
    expect(patch.optionalRemaining).toContain('q5');
  });

  it('increments questionsCompleted', () => {
    const session = makeSession({ questionsCompleted: 1 });
    const patch = applyQuestionSkipped(
      session,
      'q2',
      'technology',
      '2026-01-01T01:00:00.000Z',
    );
    expect(patch.questionsCompleted).toBe(2);
  });

  it('updates lastActivityAt and resets idleWarningShown', () => {
    const session = makeSession({ idleWarningShown: true });
    const now = '2026-03-20T08:00:00.000Z';
    const patch = applyQuestionSkipped(session, 'q1', 'process', now);
    expect(patch.lastActivityAt).toBe(now);
    expect(patch.idleWarningShown).toBe(false);
  });

  it('does not mutate original session', () => {
    const session = makeSession();
    const originalSkipped = [...session.questionsSkipped];
    applyQuestionSkipped(session, 'q1', 'process', '2026-01-01T01:00:00.000Z');
    expect(session.questionsSkipped).toEqual(originalSkipped);
  });
});

// --- applyFollowupTriggered ---

describe('applyFollowupTriggered', () => {
  it('appends a new triggered followup entry', () => {
    const patch = applyFollowupTriggered(makeSession(), 'q1', [
      'q-follow1',
      'q-follow2',
    ]);
    expect(patch.triggeredFollowups).toHaveLength(1);
    expect(patch.triggeredFollowups![0]).toEqual({
      triggeredBy: 'q1',
      suggested: ['q-follow1', 'q-follow2'],
    });
  });

  it('preserves existing followup entries', () => {
    const session = makeSession({
      triggeredFollowups: [
        { triggeredBy: 'q-prev', suggested: ['q-existing'] },
      ],
    });
    const patch = applyFollowupTriggered(session, 'q1', ['q-new']);
    expect(patch.triggeredFollowups).toHaveLength(2);
    expect(patch.triggeredFollowups![0].triggeredBy).toBe('q-prev');
    expect(patch.triggeredFollowups![1].triggeredBy).toBe('q1');
  });

  it('handles empty suggested followups', () => {
    const patch = applyFollowupTriggered(makeSession(), 'q1', []);
    expect(patch.triggeredFollowups![0].suggested).toEqual([]);
  });
});

// --- buildTurnContext ---

describe('buildTurnContext', () => {
  const standardMap = makeQuestionMap([
    {
      questionId: 'q1',
      text: 'Process question?',
      categoryBucket: 'process',
      followupTriggers: [
        { condition: 'If response is brief', followupQuestionId: 'q4' },
      ],
    },
    {
      questionId: 'q2',
      text: 'Tech question?',
      categoryBucket: 'technology',
    },
    {
      questionId: 'q3',
      text: 'Culture question?',
      categoryBucket: 'culture',
    },
    {
      questionId: 'q4',
      text: 'Follow-up question?',
      categoryBucket: 'process',
    },
    {
      questionId: 'q5',
      text: 'Optional question?',
      categoryBucket: 'technology',
    },
  ]);

  it('lists questions asked so far with text', () => {
    const session = makeSession({ questionsAsked: ['q1', 'q2'] });
    const ctx = buildTurnContext(session, standardMap, 'q2');
    expect(ctx.questionsAskedSoFar).toEqual([
      { questionId: 'q1', text: 'Process question?' },
      { questionId: 'q2', text: 'Tech question?' },
    ]);
  });

  it('skips unknown question IDs in asked list', () => {
    const session = makeSession({ questionsAsked: ['q1', 'unknown-id'] });
    const ctx = buildTurnContext(session, standardMap, 'q1');
    expect(ctx.questionsAskedSoFar).toHaveLength(1);
    expect(ctx.questionsAskedSoFar[0].questionId).toBe('q1');
  });

  it('identifies underrepresented buckets', () => {
    const session = makeSession({
      bucketsCovered: { process: 3, technology: 0, culture: 1 },
    });
    const ctx = buildTurnContext(session, standardMap, 'q2');
    // Average is (3+0+1)/3 ≈ 1.33; technology (0) and culture (1) are below
    expect(ctx.underrepresentedBuckets).toContain('technology');
    expect(ctx.underrepresentedBuckets).toContain('culture');
    expect(ctx.underrepresentedBuckets).not.toContain('process');
  });

  it('returns no underrepresented buckets when all equal', () => {
    const session = makeSession({
      bucketsCovered: { process: 2, technology: 2, culture: 2 },
    });
    const ctx = buildTurnContext(session, standardMap, 'q1');
    expect(ctx.underrepresentedBuckets).toEqual([]);
  });

  it('handles empty bucket coverage', () => {
    const session = makeSession({ bucketsCovered: {} });
    const ctx = buildTurnContext(session, standardMap, 'q1');
    expect(ctx.underrepresentedBuckets).toEqual([]);
  });

  it('returns remaining required questions with text', () => {
    const session = makeSession({ requiredRemaining: ['q2', 'q3'] });
    const ctx = buildTurnContext(session, standardMap, 'q1');
    expect(ctx.requiredRemaining).toEqual([
      { questionId: 'q2', text: 'Tech question?' },
      { questionId: 'q3', text: 'Culture question?' },
    ]);
  });

  it('returns remaining optional questions with text', () => {
    const session = makeSession({ optionalRemaining: ['q5'] });
    const ctx = buildTurnContext(session, standardMap, 'q1');
    expect(ctx.optionalRemaining).toEqual([
      { questionId: 'q5', text: 'Optional question?' },
    ]);
  });

  it('includes triggers for the current question', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'q1');
    expect(ctx.currentQuestionTriggers).toEqual([
      { condition: 'If response is brief', followupQuestionId: 'q4' },
    ]);
  });

  it('returns empty triggers for question without triggers', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'q2');
    expect(ctx.currentQuestionTriggers).toEqual([]);
  });

  it('returns empty triggers for unknown current question', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'nonexistent');
    expect(ctx.currentQuestionTriggers).toEqual([]);
  });

  it('provides correct question counts', () => {
    const session = makeSession({
      questionsAsked: ['q1', 'q2'],
      totalExpectedQuestions: 5,
    });
    const ctx = buildTurnContext(session, standardMap, 'q2');
    expect(ctx.questionsAskedCount).toBe(2);
    expect(ctx.totalExpectedQuestions).toBe(5);
  });

  it('does not mutate session bucketsCovered', () => {
    const session = makeSession();
    const originalBuckets = { ...session.bucketsCovered };
    const ctx = buildTurnContext(session, standardMap, 'q1');
    ctx.bucketsCovered.process = 999;
    expect(session.bucketsCovered).toEqual(originalBuckets);
  });
});

// --- formatTurnContext ---

describe('formatTurnContext', () => {
  const standardMap = makeQuestionMap([
    {
      questionId: 'q1',
      text: 'Process Q?',
      categoryBucket: 'process',
      followupTriggers: [
        { condition: 'If brief response', followupQuestionId: 'q2' },
      ],
    },
    { questionId: 'q2', text: 'Follow-up?', categoryBucket: 'process' },
    { questionId: 'q3', text: 'Tech Q?', categoryBucket: 'technology' },
  ]);

  it('formats progress header with question count', () => {
    const ctx = buildTurnContext(
      makeSession({
        questionsAsked: ['q1'],
        totalExpectedQuestions: 5,
      }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).toContain('## Interview Progress');
    expect(text).toContain('Questions asked: 1 / 5');
  });

  it('lists asked questions', () => {
    const ctx = buildTurnContext(
      makeSession({ questionsAsked: ['q1'] }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).toContain('### Questions Asked So Far');
    expect(text).toContain('- [q1] Process Q?');
  });

  it('omits asked section when no questions asked', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'q1');
    const text = formatTurnContext(ctx);
    expect(text).not.toContain('### Questions Asked So Far');
  });

  it('marks underrepresented buckets in coverage', () => {
    const ctx = buildTurnContext(
      makeSession({
        bucketsCovered: { process: 2, technology: 0 },
        questionsAsked: ['q1'],
      }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).toContain('### Category Coverage');
    expect(text).toContain('process: 2 question(s)');
    expect(text).toContain('technology: 0 question(s) (underrepresented)');
  });

  it('formats remaining required questions', () => {
    const ctx = buildTurnContext(
      makeSession({ requiredRemaining: ['q3'] }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).toContain('### Remaining Required Questions');
    expect(text).toContain('- [q3] Tech Q?');
  });

  it('omits remaining required section when empty', () => {
    const ctx = buildTurnContext(
      makeSession({ requiredRemaining: [] }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).not.toContain('### Remaining Required Questions');
  });

  it('formats remaining optional questions', () => {
    const ctx = buildTurnContext(
      makeSession({ optionalRemaining: ['q2'] }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).toContain('### Remaining Optional Questions');
    expect(text).toContain('- [q2] Follow-up?');
  });

  it('omits optional section when empty', () => {
    const ctx = buildTurnContext(
      makeSession({ optionalRemaining: [] }),
      standardMap,
      'q1',
    );
    const text = formatTurnContext(ctx);
    expect(text).not.toContain('### Remaining Optional Questions');
  });

  it('formats trigger section for current question', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'q1');
    const text = formatTurnContext(ctx);
    expect(text).toContain('### Follow-Up Triggers for Current Question');
    expect(text).toContain("Evaluate these against the user's response:");
    expect(text).toContain('If brief response');
    expect(text).toContain('suggest follow-up q2');
  });

  it('omits trigger section when no triggers', () => {
    const ctx = buildTurnContext(makeSession(), standardMap, 'q3');
    const text = formatTurnContext(ctx);
    expect(text).not.toContain('### Follow-Up Triggers');
  });
});
