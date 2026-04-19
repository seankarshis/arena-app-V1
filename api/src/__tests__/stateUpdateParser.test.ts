// ---------------------------------------------------------------------------
// Unit Tests — stateUpdateParser (ADR 009)
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { parseStateUpdate } from '../services/stateUpdateParser';
import type { ParseResult, StateUpdate } from '../services/stateUpdateParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid StateUpdate JSON string. */
function makeStateJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    decisionType: 'probe_deeper',
    sourceQuestionId: 'q-identity',
    targetQuestionId: 'q-identity',
    reasoning: 'Rich territory — follow up on shared credentials.',
    coverageUpdates: [
      {
        questionId: 'q-identity',
        status: 'partially_covered',
        confidence: 'medium',
        summary: 'AD plus SaaS sprawl; inconsistent SSO.',
      },
    ],
    flaggedItems: [],
    ...overrides,
  };
  return JSON.stringify(base);
}

/** Wrap JSON in delimiters with optional surrounding whitespace. */
function wrap(json: string, padStart = '', padEnd = ''): string {
  return `---STATE_UPDATE---${padStart}${json}${padEnd}---END_STATE_UPDATE---`;
}

/** Build a full LLM response: conversational text + delimiter block. */
function makeResponse(
  conversational: string,
  stateJson: string,
  padStart = '\n',
  padEnd = '\n',
): string {
  return conversational + wrap(stateJson, padStart, padEnd);
}

/** Known question IDs used across tests. */
const KNOWN_IDS = new Set(['q-identity', 'q-vendor', 'q-team']);

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('returns ok:true with extracted conversational text and parsed stateUpdate', () => {
    const conversational = 'That rings true for a lot of environments we see.';
    const result = parseStateUpdate(
      makeResponse(conversational, makeStateJson()),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return; // type narrowing

    expect(result.conversational).toBe(conversational);
    expect(result.stateUpdate.decisionType).toBe('probe_deeper');
    expect(result.stateUpdate.sourceQuestionId).toBe('q-identity');
    expect(result.stateUpdate.targetQuestionId).toBe('q-identity');
    expect(result.stateUpdate.coverageUpdates).toHaveLength(1);
    expect(result.stateUpdate.coverageUpdates[0].questionId).toBe('q-identity');
    expect(result.stateUpdate.coverageUpdates[0].status).toBe('partially_covered');
    expect(result.stateUpdate.coverageUpdates[0].confidence).toBe('medium');
    expect(result.stateUpdate.flaggedItems).toHaveLength(0);
  });

  it('empty coverageUpdates and flaggedItems are valid', () => {
    const json = makeStateJson({
      coverageUpdates: [],
      flaggedItems: [],
    });
    const result = parseStateUpdate(
      makeResponse('Some response.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.stateUpdate.coverageUpdates).toEqual([]);
    expect(result.stateUpdate.flaggedItems).toEqual([]);
  });

  it('omitted coverageUpdates and flaggedItems default to empty arrays (Zod default)', () => {
    const json = JSON.stringify({
      decisionType: 'move_on',
      sourceQuestionId: 'q-identity',
      targetQuestionId: 'q-vendor',
      reasoning: 'Covered enough here.',
      // coverageUpdates and flaggedItems intentionally absent
    });
    const result = parseStateUpdate(
      makeResponse('Moving on.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.stateUpdate.coverageUpdates).toEqual([]);
    expect(result.stateUpdate.flaggedItems).toEqual([]);
  });

  it('all valid LLM decisionType values are accepted', () => {
    const validTypes = [
      'probe_deeper',
      'pivot_related',
      'move_on',
      'circle_back',
      'flag_out_of_scope',
      'close_interview',
    ] as const;

    for (const dt of validTypes) {
      const result = parseStateUpdate(
        makeResponse('text', makeStateJson({ decisionType: dt })),
        KNOWN_IDS,
      );
      expect(result.ok).toBe(true);
      if (result.ok !== true) continue;
      expect(result.stateUpdate.decisionType).toBe(dt);
    }
  });

  it('null sourceQuestionId and null targetQuestionId are accepted', () => {
    const json = makeStateJson({
      sourceQuestionId: null,
      targetQuestionId: null,
    });
    const result = parseStateUpdate(
      makeResponse('Opening response.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.stateUpdate.sourceQuestionId).toBeNull();
    expect(result.stateUpdate.targetQuestionId).toBeNull();
  });

  it('flaggedItems with suggestedTags are preserved', () => {
    const json = makeStateJson({
      flaggedItems: [
        { description: 'Vendor dispute mentioned', priority: 'high', suggestedTags: ['legal', 'vendor'] },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Noted.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.stateUpdate.flaggedItems).toHaveLength(1);
    expect(result.stateUpdate.flaggedItems[0].priority).toBe('high');
    expect(result.stateUpdate.flaggedItems[0].suggestedTags).toEqual(['legal', 'vendor']);
  });
});

// ---------------------------------------------------------------------------
// Delimiter at end of response (no trailing conversational text after block)
// ---------------------------------------------------------------------------

describe('delimiter positions', () => {
  it('works when the delimiter block is the entire response (no leading text)', () => {
    const result = parseStateUpdate(
      wrap(makeStateJson()) ,
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.conversational).toBe('');
  });

  it('works when ---END_STATE_UPDATE--- is the very last character', () => {
    const response = 'Conversational part.' + wrap(makeStateJson());
    const result = parseStateUpdate(response, KNOWN_IDS);

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.conversational).toBe('Conversational part.');
  });

  it('extra whitespace around JSON (newlines, spaces) is tolerated', () => {
    const result = parseStateUpdate(
      makeResponse('Response.', makeStateJson(), '\n  \n', '\n  \n'),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
  });

  it('extra whitespace around the delimiters themselves does not confuse the split', () => {
    // The delimiter text includes whitespace before ---STATE_UPDATE---
    const response = 'Conversational.  \n---STATE_UPDATE---\n' +
      makeStateJson() +
      '\n---END_STATE_UPDATE---';
    const result = parseStateUpdate(response, KNOWN_IDS);

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    // Leading text before delimiter (including spaces/newline) is conversational
    expect(result.conversational).toBe('Conversational.  \n');
  });
});

// ---------------------------------------------------------------------------
// missing_block
// ---------------------------------------------------------------------------

describe('missing_block', () => {
  it('returns ok:false / missing_block when no ---STATE_UPDATE--- delimiter found', () => {
    const text = 'This is just a plain response with no structured block.';
    const result = parseStateUpdate(text, KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('missing_block');
    expect(result.conversational).toBe(text);
  });

  it('empty string returns missing_block', () => {
    const result = parseStateUpdate('', KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('missing_block');
    expect(result.conversational).toBe('');
  });

  it('text with only ---END_STATE_UPDATE--- (no start) returns missing_block', () => {
    const text = 'Some text---END_STATE_UPDATE---trailing';
    const result = parseStateUpdate(text, KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('missing_block');
  });
});

// ---------------------------------------------------------------------------
// invalid_json
// ---------------------------------------------------------------------------

describe('invalid_json', () => {
  it('returns ok:false / invalid_json when delimiters are present but body is not valid JSON', () => {
    const response = 'Some conversational text.---STATE_UPDATE---{ not valid json }---END_STATE_UPDATE---';
    const result = parseStateUpdate(response, KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('invalid_json');
    expect(result.conversational).toBe('Some conversational text.');
  });

  it('returns ok:false / invalid_json for completely empty block', () => {
    const response = 'Conversational.---STATE_UPDATE------END_STATE_UPDATE---';
    const result = parseStateUpdate(response, KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('invalid_json');
  });

  it('returns ok:false / invalid_json for truncated JSON (missing end delimiter also means incomplete)', () => {
    // Start delimiter present but end delimiter is absent — rawBlock is everything
    // after the start. The JSON is truncated so it's invalid.
    const response = 'Conversational.---STATE_UPDATE---{"decisionType": "probe_deeper"';
    const result = parseStateUpdate(response, KNOWN_IDS);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    // Either invalid_json (because truncated JSON) or schema_mismatch —
    // either is acceptable; just not ok:true.
    expect(['invalid_json', 'schema_mismatch']).toContain(result.errorType);
    expect(result.conversational).toBe('Conversational.');
  });
});

// ---------------------------------------------------------------------------
// schema_mismatch
// ---------------------------------------------------------------------------

describe('schema_mismatch', () => {
  it('returns ok:false / schema_mismatch when decisionType is missing', () => {
    const json = JSON.stringify({
      // decisionType intentionally absent
      sourceQuestionId: null,
      targetQuestionId: null,
      reasoning: 'No decision type here.',
      coverageUpdates: [],
      flaggedItems: [],
    });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('schema_mismatch');
    expect(result.conversational).toBe('Conversational.');
  });

  it('returns ok:false / schema_mismatch when decisionType is not a valid enum value', () => {
    const json = makeStateJson({ decisionType: 'hallucinate_something' });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('schema_mismatch');
  });

  it('returns ok:false / schema_mismatch when fallback (system value) is used as decisionType', () => {
    // 'fallback' is a system-synthesized value — the LLM must not emit it.
    const json = makeStateJson({ decisionType: 'fallback' });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('schema_mismatch');
  });

  it('returns ok:false / schema_mismatch when coverageUpdates[*].status is invalid', () => {
    const json = makeStateJson({
      coverageUpdates: [
        { questionId: 'q-identity', status: 'covered_fully_invalid', confidence: 'high', summary: 'done' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('schema_mismatch');
  });

  it('returns ok:false / schema_mismatch when reasoning is absent', () => {
    const json = JSON.stringify({
      decisionType: 'move_on',
      sourceQuestionId: null,
      targetQuestionId: null,
      // reasoning missing
      coverageUpdates: [],
      flaggedItems: [],
    });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errorType).toBe('schema_mismatch');
  });

  it('partialApplied is false for schema_mismatch (no state applied)', () => {
    // Verify the shape doesn't accidentally include a stateUpdate
    const json = makeStateJson({ decisionType: 'not_valid' });
    const result = parseStateUpdate(
      makeResponse('Text.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(false);
    // The ok:false variant must NOT have a stateUpdate property
    expect('stateUpdate' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unknown_question_id — ok:'partial' path
// ---------------------------------------------------------------------------

describe('unknown_question_id', () => {
  it('drops coverageUpdate entry with unknown questionId and returns ok:partial', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-identity',
      targetQuestionId: 'q-vendor',
      coverageUpdates: [
        { questionId: 'q-identity', status: 'partially_covered', confidence: 'medium', summary: 'Good.' },
        { questionId: 'q-vendor', status: 'not_started', confidence: 'low', summary: 'Not yet.' },
        { questionId: 'q-unknown-xyz', status: 'fully_covered', confidence: 'high', summary: 'Unknown.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Some text.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    expect(result.errorType).toBe('unknown_question_id');
    expect(result.unknownQuestionIdCount).toBe(1);
    // The two valid entries survive
    expect(result.stateUpdate.coverageUpdates).toHaveLength(2);
    expect(result.stateUpdate.coverageUpdates.map((u) => u.questionId)).toEqual([
      'q-identity',
      'q-vendor',
    ]);
  });

  it('nulls out unknown sourceQuestionId and still returns ok:partial with count', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-does-not-exist',
      targetQuestionId: 'q-identity',
      coverageUpdates: [
        { questionId: 'q-identity', status: 'fully_covered', confidence: 'high', summary: 'Done.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Conversational.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    expect(result.stateUpdate.sourceQuestionId).toBeNull();
    expect(result.stateUpdate.targetQuestionId).toBe('q-identity');
    expect(result.unknownQuestionIdCount).toBe(1);
    // coverageUpdates entry is valid — still present
    expect(result.stateUpdate.coverageUpdates).toHaveLength(1);
  });

  it('nulls out unknown targetQuestionId and counts it', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-identity',
      targetQuestionId: 'q-no-such-id',
      coverageUpdates: [],
    });
    const result = parseStateUpdate(
      makeResponse('Text.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    expect(result.stateUpdate.targetQuestionId).toBeNull();
    expect(result.unknownQuestionIdCount).toBe(1);
  });

  it('multiple unknowns across source, target, and coverageUpdates accumulate the count', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-bad-source',
      targetQuestionId: 'q-bad-target',
      coverageUpdates: [
        { questionId: 'q-identity', status: 'fully_covered', confidence: 'high', summary: 'OK.' },
        { questionId: 'q-bad-coverage', status: 'not_started', confidence: 'low', summary: 'Bad.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Multi-unknown.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    // 3 unknowns: bad-source, bad-target, bad-coverage
    expect(result.unknownQuestionIdCount).toBe(3);
    expect(result.stateUpdate.sourceQuestionId).toBeNull();
    expect(result.stateUpdate.targetQuestionId).toBeNull();
    expect(result.stateUpdate.coverageUpdates).toHaveLength(1);
    expect(result.stateUpdate.coverageUpdates[0].questionId).toBe('q-identity');
  });

  it('all coverageUpdates dropped → stateUpdate still valid with empty array', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-identity',
      targetQuestionId: null,
      coverageUpdates: [
        { questionId: 'q-bad-1', status: 'fully_covered', confidence: 'high', summary: 'Gone.' },
        { questionId: 'q-bad-2', status: 'fully_covered', confidence: 'high', summary: 'Also gone.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Text.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    expect(result.stateUpdate.coverageUpdates).toEqual([]);
    expect(result.unknownQuestionIdCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unknown IDs that are null — should never count as unknown
// ---------------------------------------------------------------------------

describe('null questionIds are not considered unknown', () => {
  it('null sourceQuestionId with valid everything else returns ok:true', () => {
    const json = makeStateJson({
      sourceQuestionId: null,
      targetQuestionId: 'q-vendor',
      coverageUpdates: [
        { questionId: 'q-vendor', status: 'not_started', confidence: 'low', summary: 'Not yet.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Opening turn.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
  });

  it('null targetQuestionId with valid everything else returns ok:true', () => {
    const json = makeStateJson({
      sourceQuestionId: 'q-identity',
      targetQuestionId: null,
      coverageUpdates: [],
    });
    const result = parseStateUpdate(
      makeResponse('Staying on topic.', json),
      KNOWN_IDS,
    );

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty knownQuestionIds set
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty knownQuestionIds set causes all non-null questionIds to be unknown', () => {
    const emptySet = new Set<string>();
    const json = makeStateJson({
      sourceQuestionId: 'q-identity',
      coverageUpdates: [
        { questionId: 'q-identity', status: 'partially_covered', confidence: 'medium', summary: 'Test.' },
      ],
    });
    const result = parseStateUpdate(
      makeResponse('Text.', json),
      emptySet,
    );

    expect(result.ok).toBe('partial');
    if (result.ok !== 'partial') return;
    expect(result.unknownQuestionIdCount).toBeGreaterThan(0);
  });

  it('pure function: calling twice with same input returns equal results', () => {
    const text = makeResponse('Text.', makeStateJson());
    const r1 = parseStateUpdate(text, KNOWN_IDS);
    const r2 = parseStateUpdate(text, KNOWN_IDS);
    expect(r1).toEqual(r2);
  });
});
