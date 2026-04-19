// ---------------------------------------------------------------------------
// Unit Tests — api/src/observability/events.ts
//
// Covers: happy path, severity branching, closed-enum rejection, PII safety.
//
// clickHouseWrite is mocked so tests never touch the network. The mock
// captures every call so assertions can inspect event_type, severity, and the
// attributes payload for PII violations.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock clickHouseWrite BEFORE importing the module under test so the module
// picks up the mock version.
// ---------------------------------------------------------------------------

vi.mock('../observability/clickhouseWriter', () => ({
  clickHouseWrite: vi.fn(),
}));

import { clickHouseWrite } from '../observability/clickhouseWriter';
import {
  emitOrchestrationDecision,
  emitCoverageTransition,
  emitEnrichmentJob,
  emitFlaggedItem,
  emitStateParseFailure,
} from '../observability/events';

const mockWrite = vi.mocked(clickHouseWrite);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the most recent clickHouseWrite call's arguments. */
function lastCall(): [string, Record<string, unknown>, Record<string, unknown>] {
  const calls = mockWrite.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1];
  return [last[0] as string, last[1] as Record<string, unknown>, (last[2] ?? {}) as Record<string, unknown>];
}

// ---------------------------------------------------------------------------
// emitOrchestrationDecision
// ---------------------------------------------------------------------------

describe('emitOrchestrationDecision', () => {
  beforeEach(() => { mockWrite.mockClear(); });

  it('writes to event_type orchestration_decisions', () => {
    emitOrchestrationDecision({
      interviewId: 'iid-1',
      templateId: 'tid-1',
      turnNumber: 3,
      decisionType: 'probe_deeper',
      sourceQuestionId: 'qid-src',
      targetQuestionId: '',
      openQuestionCount: 5,
      activeThreadCount: 2,
      promptTokens: 800,
      completionTokens: 150,
      latencyMs: 420,
      model: 'claude-sonnet-4-20250514',
    });

    const [eventType] = lastCall();
    expect(eventType).toBe('orchestration_decisions');
  });

  it('uses INFO severity for non-fallback decision types', () => {
    const nonFallback = [
      'probe_deeper', 'pivot_related', 'move_on',
      'circle_back', 'flag_out_of_scope', 'close_interview',
    ] as const;

    for (const decisionType of nonFallback) {
      mockWrite.mockClear();
      emitOrchestrationDecision({
        interviewId: 'iid-1',
        templateId: 'tid-1',
        turnNumber: 1,
        decisionType,
        sourceQuestionId: 'qid-a',
        targetQuestionId: '',
        openQuestionCount: 3,
        activeThreadCount: 1,
        promptTokens: 500,
        completionTokens: 100,
        latencyMs: 300,
        model: 'claude-sonnet-4-20250514',
      });
      const [, , opts] = lastCall();
      expect(opts.severity, `expected INFO for decisionType="${decisionType}"`).toBe('INFO');
    }
  });

  it('uses WARN severity when decisionType is fallback', () => {
    emitOrchestrationDecision({
      interviewId: 'iid-2',
      templateId: 'tid-2',
      turnNumber: 7,
      decisionType: 'fallback',
      sourceQuestionId: 'qid-src',
      targetQuestionId: '',
      openQuestionCount: 2,
      activeThreadCount: 0,
      promptTokens: 900,
      completionTokens: 200,
      latencyMs: 550,
      model: 'claude-sonnet-4-20250514',
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('WARN');
  });

  it('includes all required non-PII attributes', () => {
    emitOrchestrationDecision({
      interviewId: 'iid-3',
      templateId: 'tid-3',
      turnNumber: 10,
      decisionType: 'move_on',
      sourceQuestionId: 'qid-src',
      targetQuestionId: 'qid-tgt',
      openQuestionCount: 4,
      activeThreadCount: 1,
      promptTokens: 700,
      completionTokens: 120,
      latencyMs: 380,
      model: 'claude-haiku-4-20250514',
    });

    const [, payload] = lastCall();
    expect(payload.turnNumber).toBe(10);
    expect(payload.decisionType).toBe('move_on');
    expect(payload.openQuestionCount).toBe(4);
    expect(payload.activeThreadCount).toBe(1);
    expect(payload.promptTokens).toBe(700);
    expect(payload.completionTokens).toBe(120);
    expect(payload.latencyMs).toBe(380);
    expect(payload.model).toBe('claude-haiku-4-20250514');
  });

  // TypeScript's type system enforces the decisionType closed enum at compile
  // time. Runtime callers using strongly-typed code cannot pass invalid values.
  // The valid set is: probe_deeper | pivot_related | move_on | circle_back |
  // flag_out_of_scope | close_interview | fallback. The two severity branches above
  // exercise all seven values across the test suite.
  it('PII safety: payload does not contain text content, summaries, or question text', () => {
    emitOrchestrationDecision({
      interviewId: 'iid-pii',
      templateId: 'tid-pii',
      turnNumber: 1,
      decisionType: 'move_on',
      sourceQuestionId: 'qid-src',
      targetQuestionId: 'qid-tgt',
      openQuestionCount: 1,
      activeThreadCount: 0,
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      model: 'claude-sonnet-4-20250514',
    });

    const [, payload] = lastCall();
    const payloadStr = JSON.stringify(payload);
    // No text-bearing keys
    expect(payloadStr).not.toContain('summary');
    expect(payloadStr).not.toContain('questionText');
    expect(payloadStr).not.toContain('transcript');
    expect(payloadStr).not.toContain('content');
    expect(payloadStr).not.toContain('email');
    expect(payloadStr).not.toContain('name');
  });
});

// ---------------------------------------------------------------------------
// emitCoverageTransition
// ---------------------------------------------------------------------------

describe('emitCoverageTransition', () => {
  beforeEach(() => { mockWrite.mockClear(); });

  it('writes to event_type coverage_transitions', () => {
    emitCoverageTransition({
      interviewId: 'iid-1',
      questionId: 'qid-1',
      templateId: 'tid-1',
      oldStatus: 'not_started',
      newStatus: 'partially_covered',
      oldConfidence: null,
      newConfidence: 'low',
      turnNumber: 2,
      hasSummary: false,
      summaryLength: 0,
    });

    const [eventType] = lastCall();
    expect(eventType).toBe('coverage_transitions');
  });

  it('always uses INFO severity', () => {
    emitCoverageTransition({
      interviewId: 'iid-1',
      questionId: 'qid-1',
      templateId: 'tid-1',
      oldStatus: 'partially_covered',
      newStatus: 'fully_covered',
      oldConfidence: 'low',
      newConfidence: 'high',
      turnNumber: 5,
      hasSummary: true,
      summaryLength: 240,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('includes hasSummary and summaryLength but not the summary text', () => {
    emitCoverageTransition({
      interviewId: 'iid-2',
      questionId: 'qid-2',
      templateId: 'tid-2',
      oldStatus: 'not_started',
      newStatus: 'fully_covered',
      oldConfidence: null,
      newConfidence: 'medium',
      turnNumber: 8,
      hasSummary: true,
      summaryLength: 312,
    });

    const [, payload] = lastCall();
    expect(payload.hasSummary).toBe(true);
    expect(payload.summaryLength).toBe(312);
  });

  it('PII safety: payload does not include summary text or any content string', () => {
    emitCoverageTransition({
      interviewId: 'iid-pii',
      questionId: 'qid-pii',
      templateId: 'tid-pii',
      oldStatus: 'not_started',
      newStatus: 'partially_covered',
      oldConfidence: null,
      newConfidence: 'low',
      turnNumber: 1,
      hasSummary: true,
      summaryLength: 150,
    });

    const [, payload] = lastCall();
    const payloadStr = JSON.stringify(payload);
    // The summary itself must never appear — only the length and boolean flag
    expect(payloadStr).not.toContain('summaryText');
    expect(payloadStr).not.toContain('summaryContent');
    expect(payloadStr).not.toContain('transcript');
    expect(payloadStr).not.toContain('email');
    expect(payloadStr).not.toContain('questionText');
    // Confirm no value is a long string (summary content would be)
    for (const val of Object.values(payload)) {
      if (typeof val === 'string') {
        expect(val.length, `Unexpected long string value in payload: "${val.slice(0, 50)}..."`).toBeLessThan(100);
      }
    }
  });

  it('passes oldConfidence as null when no prior confidence exists', () => {
    emitCoverageTransition({
      interviewId: 'iid-3',
      questionId: 'qid-3',
      templateId: 'tid-3',
      oldStatus: 'not_started',
      newStatus: 'partially_covered',
      oldConfidence: null,
      newConfidence: 'medium',
      turnNumber: 1,
      hasSummary: false,
      summaryLength: 0,
    });

    const [, payload] = lastCall();
    expect(payload.oldConfidence).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emitEnrichmentJob
// ---------------------------------------------------------------------------

describe('emitEnrichmentJob', () => {
  beforeEach(() => { mockWrite.mockClear(); });

  it('writes to event_type enrichment_jobs', () => {
    emitEnrichmentJob({
      responseId: 'rid-1',
      interviewId: 'iid-1',
      jobType: 'enrichment',
      status: 'started',
      attemptNumber: 1,
      retryCount: 0,
      durationMs: 0,
    });

    const [eventType] = lastCall();
    expect(eventType).toBe('enrichment_jobs');
  });

  it('passes serviceName arena-enrichment on every write', () => {
    emitEnrichmentJob({
      responseId: 'rid-1',
      interviewId: 'iid-1',
      jobType: 'enrichment',
      status: 'started',
      attemptNumber: 1,
      retryCount: 0,
      durationMs: 0,
    });

    const [, , opts] = lastCall();
    expect(opts.serviceName).toBe('arena-enrichment');
  });

  it('uses INFO severity for started status', () => {
    emitEnrichmentJob({
      responseId: 'rid-1',
      interviewId: 'iid-1',
      jobType: 'enrichment',
      status: 'started',
      attemptNumber: 1,
      retryCount: 0,
      durationMs: 0,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('uses INFO severity for retried status', () => {
    emitEnrichmentJob({
      responseId: 'rid-2',
      interviewId: 'iid-2',
      jobType: 'enrichment',
      status: 'retried',
      attemptNumber: 2,
      retryCount: 1,
      durationMs: 1200,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('uses INFO severity for succeeded with retryCount === 0', () => {
    emitEnrichmentJob({
      responseId: 'rid-3',
      interviewId: 'iid-3',
      jobType: 'enrichment',
      status: 'succeeded',
      attemptNumber: 1,
      retryCount: 0,
      durationMs: 3400,
      model: 'claude-haiku-4-20250514',
      promptTokens: 400,
      completionTokens: 80,
      entityCount: 5,
      tagCount: 3,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('uses WARN severity for succeeded with retryCount > 0', () => {
    emitEnrichmentJob({
      responseId: 'rid-4',
      interviewId: 'iid-4',
      jobType: 'enrichment',
      status: 'succeeded',
      attemptNumber: 3,
      retryCount: 2,
      durationMs: 8000,
      model: 'claude-haiku-4-20250514',
      promptTokens: 400,
      completionTokens: 80,
      entityCount: 3,
      tagCount: 2,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('WARN');
  });

  it('uses ERROR severity for failed status', () => {
    emitEnrichmentJob({
      responseId: 'rid-5',
      interviewId: 'iid-5',
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber: 3,
      retryCount: 2,
      durationMs: 15000,
      errorCode: 'llm_timeout',
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('ERROR');
  });

  it('includes all optional fields when provided', () => {
    emitEnrichmentJob({
      responseId: 'rid-6',
      interviewId: 'iid-6',
      jobType: 'enrichment',
      status: 'succeeded',
      attemptNumber: 1,
      retryCount: 0,
      durationMs: 2200,
      model: 'claude-sonnet-4-20250514',
      promptTokens: 600,
      completionTokens: 140,
      entityCount: 7,
      tagCount: 4,
    });

    const [, payload] = lastCall();
    expect(payload.model).toBe('claude-sonnet-4-20250514');
    expect(payload.promptTokens).toBe(600);
    expect(payload.completionTokens).toBe(140);
    expect(payload.entityCount).toBe(7);
    expect(payload.tagCount).toBe(4);
  });

  it('rejects invalid errorCode values at the function boundary', () => {
    expect(() => {
      emitEnrichmentJob({
        responseId: 'rid-bad',
        interviewId: 'iid-bad',
        jobType: 'enrichment',
        status: 'failed',
        attemptNumber: 1,
        retryCount: 0,
        durationMs: 500,
        // @ts-expect-error intentionally passing an invalid enum value
        errorCode: 'network_error',
      });
    }).toThrow(/Invalid errorCode/);
  });

  it('accepts all valid errorCode values without throwing', () => {
    const validCodes = [
      'llm_timeout', 'llm_error', 'invalid_response',
      'db_write_failed', 'tag_limit_exceeded', 'unknown',
    ] as const;

    for (const errorCode of validCodes) {
      mockWrite.mockClear();
      expect(() => {
        emitEnrichmentJob({
          responseId: 'rid-ok',
          interviewId: 'iid-ok',
          jobType: 'enrichment',
          status: 'failed',
          attemptNumber: 1,
          retryCount: 0,
          durationMs: 1000,
          errorCode,
        });
      }).not.toThrow();
    }
  });

  it('PII safety: payload does not include error message text or tag label values', () => {
    emitEnrichmentJob({
      responseId: 'rid-pii',
      interviewId: 'iid-pii',
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber: 2,
      retryCount: 1,
      durationMs: 5000,
      errorCode: 'llm_error',
    });

    const [, payload] = lastCall();
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain('message');
    expect(payloadStr).not.toContain('stack');
    expect(payloadStr).not.toContain('transcript');
    expect(payloadStr).not.toContain('email');
    expect(payloadStr).not.toContain('tagLabel');
    expect(payloadStr).not.toContain('tagValue');
    expect(payloadStr).not.toContain('entityValue');
  });
});

// ---------------------------------------------------------------------------
// emitFlaggedItem
// ---------------------------------------------------------------------------

describe('emitFlaggedItem', () => {
  beforeEach(() => { mockWrite.mockClear(); });

  it('writes to event_type flagged_items', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-1',
      interviewId: 'iid-1',
      templateId: 'tid-1',
      sourceTurn: 4,
      priority: 'low',
      suggestedTagCount: 2,
      descriptionLength: 180,
    });

    const [eventType] = lastCall();
    expect(eventType).toBe('flagged_items');
  });

  it('uses INFO severity for low priority', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-low',
      interviewId: 'iid-1',
      templateId: 'tid-1',
      sourceTurn: 1,
      priority: 'low',
      suggestedTagCount: 1,
      descriptionLength: 90,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('uses INFO severity for medium priority', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-med',
      interviewId: 'iid-1',
      templateId: 'tid-1',
      sourceTurn: 2,
      priority: 'medium',
      suggestedTagCount: 2,
      descriptionLength: 130,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('INFO');
  });

  it('uses WARN severity for high priority', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-high',
      interviewId: 'iid-1',
      templateId: 'tid-1',
      sourceTurn: 6,
      priority: 'high',
      suggestedTagCount: 3,
      descriptionLength: 200,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('WARN');
  });

  it('uses ERROR severity for critical priority', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-crit',
      interviewId: 'iid-1',
      templateId: 'tid-1',
      sourceTurn: 12,
      priority: 'critical',
      suggestedTagCount: 5,
      descriptionLength: 350,
    });

    const [, , opts] = lastCall();
    expect(opts.severity).toBe('ERROR');
  });

  it('includes suggestedTagCount and descriptionLength in payload', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-attrs',
      interviewId: 'iid-2',
      templateId: 'tid-2',
      sourceTurn: 7,
      priority: 'high',
      suggestedTagCount: 4,
      descriptionLength: 275,
    });

    const [, payload] = lastCall();
    expect(payload.suggestedTagCount).toBe(4);
    expect(payload.descriptionLength).toBe(275);
  });

  // TypeScript type system enforces the priority closed enum at compile time:
  // 'low' | 'medium' | 'high' | 'critical'. All four values are exercised in
  // the severity-branch tests above, covering the complete valid range.
  it('PII safety: payload does not include description text or tag label values', () => {
    emitFlaggedItem({
      flaggedItemId: 'fid-pii',
      interviewId: 'iid-pii',
      templateId: 'tid-pii',
      sourceTurn: 3,
      priority: 'medium',
      suggestedTagCount: 2,
      descriptionLength: 160,
    });

    const [, payload] = lastCall();
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain('description"');
    expect(payloadStr).not.toContain('tagLabel');
    expect(payloadStr).not.toContain('tagValue');
    expect(payloadStr).not.toContain('transcript');
    expect(payloadStr).not.toContain('email');
    expect(payloadStr).not.toContain('content');
    // Confirm no value is a long string (description content would be)
    for (const val of Object.values(payload)) {
      if (typeof val === 'string') {
        expect(val.length, `Unexpected long string value: "${val.slice(0, 50)}..."`).toBeLessThan(200);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// emitStateParseFailure
// ---------------------------------------------------------------------------

describe('emitStateParseFailure', () => {
  beforeEach(() => { mockWrite.mockClear(); });

  it('writes to event_type state_parse_failures', () => {
    emitStateParseFailure({
      interviewId: 'iid-1',
      turnNumber: 5,
      parseErrorType: 'missing_block',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 900,
      completionTokens: 300,
      partialApplied: false,
    });

    const [eventType] = lastCall();
    expect(eventType).toBe('state_parse_failures');
  });

  it('always uses WARN severity', () => {
    const errorTypes = [
      'missing_block', 'invalid_json', 'schema_mismatch', 'unknown_question_id',
    ] as const;

    for (const parseErrorType of errorTypes) {
      mockWrite.mockClear();
      emitStateParseFailure({
        interviewId: 'iid-1',
        turnNumber: 1,
        parseErrorType,
        model: 'claude-sonnet-4-20250514',
        promptTokens: 500,
        completionTokens: 100,
        partialApplied: false,
      });

      const [, , opts] = lastCall();
      expect(opts.severity, `expected WARN for parseErrorType="${parseErrorType}"`).toBe('WARN');
    }
  });

  it('includes unknownQuestionIdCount when provided', () => {
    emitStateParseFailure({
      interviewId: 'iid-2',
      turnNumber: 9,
      parseErrorType: 'unknown_question_id',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 850,
      completionTokens: 280,
      unknownQuestionIdCount: 3,
      partialApplied: true,
    });

    const [, payload] = lastCall();
    expect(payload.unknownQuestionIdCount).toBe(3);
    expect(payload.partialApplied).toBe(true);
  });

  it('omits unknownQuestionIdCount when not provided', () => {
    emitStateParseFailure({
      interviewId: 'iid-3',
      turnNumber: 2,
      parseErrorType: 'invalid_json',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 700,
      completionTokens: 200,
      partialApplied: false,
    });

    const [, payload] = lastCall();
    expect(Object.prototype.hasOwnProperty.call(payload, 'unknownQuestionIdCount')).toBe(false);
  });

  it('rejects invalid parseErrorType values at the function boundary', () => {
    expect(() => {
      emitStateParseFailure({
        interviewId: 'iid-bad',
        turnNumber: 1,
        // @ts-expect-error intentionally passing an invalid enum value
        parseErrorType: 'corrupt_output',
        model: 'claude-sonnet-4-20250514',
        promptTokens: 500,
        completionTokens: 100,
        partialApplied: false,
      });
    }).toThrow(/Invalid parseErrorType/);
  });

  it('accepts all four valid parseErrorType values without throwing', () => {
    const validTypes = [
      'missing_block', 'invalid_json', 'schema_mismatch', 'unknown_question_id',
    ] as const;

    for (const parseErrorType of validTypes) {
      mockWrite.mockClear();
      expect(() => {
        emitStateParseFailure({
          interviewId: 'iid-ok',
          turnNumber: 1,
          parseErrorType,
          model: 'claude-sonnet-4-20250514',
          promptTokens: 500,
          completionTokens: 100,
          partialApplied: false,
        });
      }).not.toThrow();
    }
  });

  it('PII safety: payload does not include raw LLM output or interviewee content', () => {
    emitStateParseFailure({
      interviewId: 'iid-pii',
      turnNumber: 4,
      parseErrorType: 'schema_mismatch',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 800,
      completionTokens: 250,
      partialApplied: true,
    });

    const [, payload] = lastCall();
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain('rawOutput');
    expect(payloadStr).not.toContain('llmOutput');
    expect(payloadStr).not.toContain('transcript');
    expect(payloadStr).not.toContain('email');
    expect(payloadStr).not.toContain('content');
    expect(payloadStr).not.toContain('questionText');
    // Confirm no value is a long string (LLM output would be)
    for (const val of Object.values(payload)) {
      if (typeof val === 'string') {
        expect(val.length, `Unexpected long string value: "${val.slice(0, 50)}..."`).toBeLessThan(200);
      }
    }
  });
});
