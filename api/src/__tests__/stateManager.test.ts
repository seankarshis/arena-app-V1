// ---------------------------------------------------------------------------
// Unit Tests — Per-Turn State Manager
//
// The legacy v1-pool helpers (applyQuestionAsked, applyQuestionSkipped,
// applyFollowupTriggered, buildTurnContext, formatTurnContext) are kept
// retained while in-flight sessions drain (see ADR 008). Their tests are
// preserved below to confirm the deprecated path still behaves correctly
// until it is removed in the next release.
//
// The new v2-coverage suite at the bottom of this file covers the
// coverage-map operations that replace the pool path.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import type { InterviewSession } from '../services/session';
import type { CoverageEntry, InterviewSessionState } from '../services/sessionState';
import type { CoverageUpdate } from '../services/stateUpdateParser';
import {
  applyQuestionAsked,
  applyResponseSubmitted,
  applyQuestionSkipped,
  applyFollowupTriggered,
  buildTurnContext,
  formatTurnContext,
  applyCoverageUpdates,
  applyFlaggedItems,
  markQuestionSkipped,
  incrementParseFailures,
  resetParseFailures,
  evaluateCompletion,
  getSessionVersion,
  reconstructSessionFromResponses,
  type CoverageCapableSession,
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

// ===========================================================================
// v2-coverage suite
// ===========================================================================

// --- Helpers ---

function makeCoverageSession(
  overrides: Partial<CoverageCapableSession> = {},
): CoverageCapableSession {
  return {
    coverage: {},
    activeThreads: [],
    factsLedger: [],
    rapportNotes: [],
    sessionVersion: 'v2-coverage',
    consecutiveParseFailures: 0,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CoverageEntry> = {}): CoverageEntry {
  return {
    status: 'not_started',
    confidence: null,
    turnNumbers: [],
    summary: null,
    ...overrides,
  };
}

// --- applyCoverageUpdates ---

describe('applyCoverageUpdates', () => {
  it('transitions statuses correctly and produces one transition record per update', () => {
    const session = makeCoverageSession({
      coverage: {
        qA: makeEntry({ status: 'not_started' }),
        qB: makeEntry({
          status: 'partially_covered',
          confidence: 'low',
          turnNumbers: [2],
          summary: 'partial',
        }),
      },
    });

    const updates: CoverageUpdate[] = [
      {
        questionId: 'qA',
        status: 'partially_covered',
        confidence: 'medium',
        summary: 'the user started discussing qA',
      },
      {
        questionId: 'qB',
        status: 'fully_covered',
        confidence: 'high',
        summary: 'qB is now fully covered',
      },
    ];

    const { newCoverage, transitions } = applyCoverageUpdates(session, updates, 3);

    expect(transitions).toHaveLength(2);

    expect(transitions[0]).toEqual({
      questionId: 'qA',
      oldStatus: 'not_started',
      oldConfidence: null,
      newStatus: 'partially_covered',
      newConfidence: 'medium',
      summary: 'the user started discussing qA',
    });

    expect(transitions[1]).toEqual({
      questionId: 'qB',
      oldStatus: 'partially_covered',
      oldConfidence: 'low',
      newStatus: 'fully_covered',
      newConfidence: 'high',
      summary: 'qB is now fully covered',
    });

    expect(newCoverage.qA.status).toBe('partially_covered');
    expect(newCoverage.qA.confidence).toBe('medium');
    expect(newCoverage.qA.summary).toBe('the user started discussing qA');
    expect(newCoverage.qA.turnNumbers).toEqual([3]);

    expect(newCoverage.qB.status).toBe('fully_covered');
    expect(newCoverage.qB.turnNumbers).toEqual([2, 3]);
  });

  it('preserves untouched entries', () => {
    const session = makeCoverageSession({
      coverage: {
        qA: makeEntry({ status: 'fully_covered', confidence: 'high', summary: 'done' }),
        qB: makeEntry({ status: 'not_started' }),
      },
    });

    const updates: CoverageUpdate[] = [
      { questionId: 'qB', status: 'partially_covered', confidence: 'low', summary: 'just started' },
    ];

    const { newCoverage, transitions } = applyCoverageUpdates(session, updates, 4);

    expect(transitions).toHaveLength(1);
    expect(newCoverage.qA).toEqual(session.coverage.qA);
    expect(newCoverage.qB.status).toBe('partially_covered');
  });

  it('treats a first write (no prior entry) as oldStatus=not_started / oldConfidence=null', () => {
    const session = makeCoverageSession({ coverage: {} });

    const updates: CoverageUpdate[] = [
      { questionId: 'qNew', status: 'partially_covered', confidence: 'medium', summary: 's' },
    ];

    const { newCoverage, transitions } = applyCoverageUpdates(session, updates, 1);

    expect(transitions[0].oldStatus).toBe('not_started');
    expect(transitions[0].oldConfidence).toBeNull();
    expect(newCoverage.qNew.turnNumbers).toEqual([1]);
  });

  it('does not mutate input session', () => {
    const initialCoverage = {
      qA: makeEntry({ status: 'not_started' }),
    };
    const session = makeCoverageSession({ coverage: initialCoverage });

    const updates: CoverageUpdate[] = [
      { questionId: 'qA', status: 'fully_covered', confidence: 'high', summary: 'ok' },
    ];

    applyCoverageUpdates(session, updates, 2);

    expect(session.coverage.qA.status).toBe('not_started');
  });

  it('handles empty updates array', () => {
    const session = makeCoverageSession();
    const { newCoverage, transitions } = applyCoverageUpdates(session, [], 1);
    expect(transitions).toEqual([]);
    expect(newCoverage).toEqual(session.coverage);
  });
});

// --- markQuestionSkipped ---

describe('markQuestionSkipped', () => {
  it('sets status=skipped and preserves prior summary', () => {
    const session = makeCoverageSession({
      coverage: {
        qA: makeEntry({
          status: 'partially_covered',
          confidence: 'medium',
          turnNumbers: [2],
          summary: 'already heard some useful detail',
        }),
      },
    });

    const next = markQuestionSkipped(session, 'qA', 5);

    expect(next.coverage.qA.status).toBe('skipped');
    expect(next.coverage.qA.summary).toBe('already heard some useful detail');
    expect(next.coverage.qA.turnNumbers).toEqual([2, 5]);
    expect(next.coverage.qA.confidence).toBeNull();
  });

  it('creates a fresh skipped entry when question has no prior coverage', () => {
    const session = makeCoverageSession({ coverage: {} });

    const next = markQuestionSkipped(session, 'qFresh', 2);

    expect(next.coverage.qFresh).toEqual({
      status: 'skipped',
      confidence: null,
      turnNumbers: [2],
      summary: null,
    });
  });

  it('does not mutate input session', () => {
    const session = makeCoverageSession({
      coverage: { qA: makeEntry({ status: 'not_started' }) },
    });
    markQuestionSkipped(session, 'qA', 1);
    expect(session.coverage.qA.status).toBe('not_started');
  });
});

// --- incrementParseFailures / resetParseFailures ---

describe('parse-failure counter', () => {
  it('incrementParseFailures bumps the counter from 0 to 1 to 2', () => {
    const s0 = makeCoverageSession({ consecutiveParseFailures: 0 });
    const s1 = incrementParseFailures(s0);
    const s2 = incrementParseFailures(s1);
    expect(s1.consecutiveParseFailures).toBe(1);
    expect(s2.consecutiveParseFailures).toBe(2);
  });

  it('resetParseFailures sets the counter back to 0', () => {
    const s0 = makeCoverageSession({ consecutiveParseFailures: 3 });
    const reset = resetParseFailures(s0);
    expect(reset.consecutiveParseFailures).toBe(0);
  });

  it('round-trips', () => {
    let s = makeCoverageSession({ consecutiveParseFailures: 0 });
    s = incrementParseFailures(s);
    s = incrementParseFailures(s);
    expect(s.consecutiveParseFailures).toBe(2);
    s = resetParseFailures(s);
    expect(s.consecutiveParseFailures).toBe(0);
    s = incrementParseFailures(s);
    expect(s.consecutiveParseFailures).toBe(1);
  });
});

// --- evaluateCompletion ---

describe('evaluateCompletion', () => {
  function makeTemplate(
    entries: Array<{ questionId: string; isRequired: boolean }>,
  ) {
    return { questions: entries };
  }

  it('returns true when all required are fully_covered with medium/high confidence', () => {
    const session = {
      coverage: {
        q1: makeEntry({ status: 'fully_covered', confidence: 'medium', summary: 's' }),
        q2: makeEntry({ status: 'fully_covered', confidence: 'high', summary: 's' }),
      },
    };
    const template = makeTemplate([
      { questionId: 'q1', isRequired: true },
      { questionId: 'q2', isRequired: true },
    ]);

    const { isComplete, gapReasons } = evaluateCompletion(session, template);
    expect(isComplete).toBe(true);
    expect(gapReasons).toEqual([]);
  });

  it('returns true when required are a mix of skipped and fully_covered (high)', () => {
    const session = {
      coverage: {
        q1: makeEntry({ status: 'skipped' }),
        q2: makeEntry({ status: 'fully_covered', confidence: 'high' }),
      },
    };
    const template = makeTemplate([
      { questionId: 'q1', isRequired: true },
      { questionId: 'q2', isRequired: true },
    ]);

    expect(evaluateCompletion(session, template).isComplete).toBe(true);
  });

  it('ignores optional questions', () => {
    const session = {
      coverage: {
        q1: makeEntry({ status: 'fully_covered', confidence: 'high' }),
        // q-opt is optional and not_started — must not block completion
      },
    };
    const template = makeTemplate([
      { questionId: 'q1', isRequired: true },
      { questionId: 'q-opt', isRequired: false },
    ]);

    expect(evaluateCompletion(session, template).isComplete).toBe(true);
  });

  it('returns false with a gap reason when a required question is partially_covered with low confidence', () => {
    const session = {
      coverage: {
        q1: makeEntry({ status: 'partially_covered', confidence: 'low' }),
      },
    };
    const template = makeTemplate([{ questionId: 'q1', isRequired: true }]);

    const { isComplete, gapReasons } = evaluateCompletion(session, template);
    expect(isComplete).toBe(false);
    expect(gapReasons).toHaveLength(1);
    expect(gapReasons[0]).toContain('q1');
    expect(gapReasons[0]).toContain('partially_covered');
  });

  it('returns false when a required question is not_started', () => {
    const session = { coverage: {} };
    const template = makeTemplate([
      { questionId: 'q1', isRequired: true },
      { questionId: 'q2', isRequired: true },
    ]);

    const { isComplete, gapReasons } = evaluateCompletion(session, template);
    expect(isComplete).toBe(false);
    expect(gapReasons).toHaveLength(2);
    expect(gapReasons.some((r) => r.includes('q1') && r.includes('not_started'))).toBe(true);
    expect(gapReasons.some((r) => r.includes('q2') && r.includes('not_started'))).toBe(true);
  });

  it('returns false when fully_covered required has confidence=low', () => {
    const session = {
      coverage: {
        q1: makeEntry({ status: 'fully_covered', confidence: 'low' }),
      },
    };
    const template = makeTemplate([{ questionId: 'q1', isRequired: true }]);

    const { isComplete, gapReasons } = evaluateCompletion(session, template);
    expect(isComplete).toBe(false);
    expect(gapReasons[0]).toContain('low');
  });
});

// --- getSessionVersion ---

describe('getSessionVersion', () => {
  it("defaults to 'v1-pool' for sessions without sessionVersion", () => {
    const session = { /* no sessionVersion */ } as { sessionVersion?: 'v1-pool' | 'v2-coverage' };
    expect(getSessionVersion(session)).toBe('v1-pool');
  });

  it("returns 'v2-coverage' when explicitly set", () => {
    expect(getSessionVersion({ sessionVersion: 'v2-coverage' })).toBe('v2-coverage');
  });

  it("returns 'v1-pool' when explicitly set", () => {
    expect(getSessionVersion({ sessionVersion: 'v1-pool' })).toBe('v1-pool');
  });
});

// --- applyFlaggedItems ---

describe('applyFlaggedItems', () => {
  function makeMockPrisma() {
    let counter = 0;
    return {
      flaggedItem: {
        create: vi.fn(async ({ data }: { data: { interviewId: string; sourceTurn: number; description: string; priority: string; suggestedTags: unknown } }) => {
          counter += 1;
          return {
            id: `flag-${counter}`,
            interviewId: data.interviewId,
            sourceTurn: data.sourceTurn,
            description: data.description,
            suggestedTags: data.suggestedTags,
            priority: data.priority,
            needsAdminReview: true,
            dismissedAt: null,
            convertedToQuestionId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }),
      },
    };
  }

  it('returns an empty array when items is empty (no DB writes)', async () => {
    const prisma = makeMockPrisma();
    const persisted = await applyFlaggedItems(
      prisma as unknown as Parameters<typeof applyFlaggedItems>[0],
      'iv-1',
      2,
      [],
    );
    expect(persisted).toEqual([]);
    expect(prisma.flaggedItem.create).not.toHaveBeenCalled();
  });

  it('writes each flagged item with correct fields and returns persisted rows', async () => {
    const prisma = makeMockPrisma();
    const items = [
      { description: 'something weird', priority: 'high' as const, suggestedTags: ['security'] },
      { description: 'edge case', priority: 'low' as const, suggestedTags: [] },
    ];

    const persisted = await applyFlaggedItems(
      prisma as unknown as Parameters<typeof applyFlaggedItems>[0],
      'iv-42',
      7,
      items,
    );

    expect(prisma.flaggedItem.create).toHaveBeenCalledTimes(2);
    expect(prisma.flaggedItem.create.mock.calls[0][0].data.priority).toBe('HIGH');
    expect(prisma.flaggedItem.create.mock.calls[0][0].data.interviewId).toBe('iv-42');
    expect(prisma.flaggedItem.create.mock.calls[0][0].data.sourceTurn).toBe(7);
    expect(prisma.flaggedItem.create.mock.calls[1][0].data.priority).toBe('LOW');

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toEqual({
      id: 'flag-1',
      interviewId: 'iv-42',
      sourceTurn: 7,
      description: 'something weird',
      suggestedTags: ['security'],
      priority: 'high',
    });
  });
});

// --- reconstructSessionFromResponses ---

describe('reconstructSessionFromResponses', () => {
  it('seeds answered questions as partially_covered with confidence=medium', async () => {
    const prisma = {
      interviewResponse: {
        findMany: vi.fn().mockResolvedValue([
          { questionId: 'qA', sequenceNumber: 1, isSkipped: false },
          { questionId: 'qB', sequenceNumber: 2, isSkipped: false },
        ]),
      },
    };

    const reconstructed = await reconstructSessionFromResponses(
      prisma as unknown as Parameters<typeof reconstructSessionFromResponses>[0],
      'iv-99',
    );

    expect(reconstructed.sessionVersion).toBe('v2-coverage');
    expect(reconstructed.consecutiveParseFailures).toBe(0);
    expect(reconstructed.factsLedger).toEqual([]);
    expect(reconstructed.activeThreads).toEqual([]);
    expect(reconstructed.rapportNotes).toEqual([]);
    expect(reconstructed.turnNumber).toBe(2);

    expect(reconstructed.coverage.qA).toEqual({
      status: 'partially_covered',
      confidence: 'medium',
      turnNumbers: [1],
      summary: null,
    });
    expect(reconstructed.coverage.qB.status).toBe('partially_covered');
    expect(reconstructed.coverage.qB.confidence).toBe('medium');
  });

  it("seeds skipped responses as status='skipped' with null confidence", async () => {
    const prisma = {
      interviewResponse: {
        findMany: vi.fn().mockResolvedValue([
          { questionId: 'qA', sequenceNumber: 1, isSkipped: false },
          { questionId: 'qSkip', sequenceNumber: 2, isSkipped: true },
        ]),
      },
    };

    const reconstructed = await reconstructSessionFromResponses(
      prisma as unknown as Parameters<typeof reconstructSessionFromResponses>[0],
      'iv-100',
    );

    expect(reconstructed.coverage.qSkip).toEqual({
      status: 'skipped',
      confidence: null,
      turnNumbers: [2],
      summary: null,
    });
    expect(reconstructed.coverage.qA.status).toBe('partially_covered');
  });

  it('returns an empty coverage map and turnNumber=0 when no responses exist', async () => {
    const prisma = {
      interviewResponse: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const reconstructed = await reconstructSessionFromResponses(
      prisma as unknown as Parameters<typeof reconstructSessionFromResponses>[0],
      'iv-empty',
    );

    expect(reconstructed.coverage).toEqual({});
    expect(reconstructed.turnNumber).toBe(0);
  });

  it('queries interview_responses filtered by interviewId and ordered by sequenceNumber', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { interviewResponse: { findMany } };

    await reconstructSessionFromResponses(
      prisma as unknown as Parameters<typeof reconstructSessionFromResponses>[0],
      'iv-query',
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ interviewId: 'iv-query' });
    expect(arg.orderBy).toEqual({ sequenceNumber: 'asc' });
  });
});

// --- Type-compat smoke test: InterviewSessionState is acceptable to coverage ops ---

describe('coverage ops accept InterviewSessionState shapes', () => {
  it('applyCoverageUpdates compiles with an InterviewSessionState input', () => {
    const state: InterviewSessionState = {
      interviewId: 'iv',
      userId: 'u',
      templateId: 't',
      turnNumber: 1,
      isStreaming: false,
      currentTurnLlmText: '',
      sessionVersion: 'v2-coverage',
      consecutiveParseFailures: 0,
      coverage: {},
      activeThreads: [],
      factsLedger: [],
      rapportNotes: [],
      questions: [],
      intervieweeName: 'x',
      intervieweeRole: 'y',
      intervieweeCompany: 'z',
      templateFocus: 'focus',
      templateSystemPromptOverride: null,
      conversationHistory: [],
      currentUserUtterance: '',
    };

    const result = applyCoverageUpdates(
      state,
      [{ questionId: 'qX', status: 'partially_covered', confidence: 'medium', summary: 's' }],
      1,
    );
    expect(result.transitions).toHaveLength(1);
  });
});
