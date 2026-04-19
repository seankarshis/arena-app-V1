// ---------------------------------------------------------------------------
// Arena Structured-Output Parser — ADR 009
//
// Parses the LLM's `---STATE_UPDATE--- / ---END_STATE_UPDATE---` delimited
// block out of the raw accumulated response text. Pure function; no I/O.
// The caller is responsible for emitting `state_parse_failures` events.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type {
  OrchestrationDecisionType,
  CoverageStatus,
  CoverageConfidence,
  FlaggedItemPriority,
  ParseErrorType,
} from '../observability/events';

// 'fallback' is a system-synthesized value; the LLM never emits it.
type LLMDecisionType = Exclude<OrchestrationDecisionType, 'fallback'>;

// ---------------------------------------------------------------------------
// Domain types exported for callers
// ---------------------------------------------------------------------------

export type CoverageUpdate = {
  questionId: string;
  status: CoverageStatus;
  confidence: CoverageConfidence;
  summary: string;
};

export type FlaggedItem = {
  description: string;
  priority: FlaggedItemPriority;
  suggestedTags: string[];
};

export type StateUpdate = {
  decisionType: LLMDecisionType;
  sourceQuestionId: string | null;
  targetQuestionId: string | null;
  reasoning: string;
  coverageUpdates: CoverageUpdate[];
  flaggedItems: FlaggedItem[];
};

// ---------------------------------------------------------------------------
// ParseResult — three-variant discriminated union
//
// ok: true    — full success; all question IDs validated.
// ok: 'partial' — unknown_question_id: valid entries were applied, count
//                 of bad IDs is reported so caller can emit telemetry.
// ok: false   — hard parse failure; no state update is available.
// ---------------------------------------------------------------------------
export type ParseResult =
  | { ok: true; conversational: string; stateUpdate: StateUpdate }
  | {
      ok: 'partial';
      conversational: string;
      stateUpdate: StateUpdate;
      errorType: 'unknown_question_id';
      unknownQuestionIdCount: number;
    }
  | {
      ok: false;
      conversational: string;
      errorType: Exclude<ParseErrorType, 'unknown_question_id'>;
    };

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

const DELIMITER_START = '---STATE_UPDATE---';
const DELIMITER_END = '---END_STATE_UPDATE---';

// ---------------------------------------------------------------------------
// Zod schema — mirrors ADR 009 JSON schema exactly
// ---------------------------------------------------------------------------

const CoverageStatusSchema = z.enum([
  'not_started',
  'partially_covered',
  'fully_covered',
  'skipped',
] satisfies [CoverageStatus, ...CoverageStatus[]]);

const CoverageConfidenceSchema = z.enum([
  'low',
  'medium',
  'high',
] satisfies [CoverageConfidence, ...CoverageConfidence[]]);

const FlaggedItemPrioritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
] satisfies [FlaggedItemPriority, ...FlaggedItemPriority[]]);

// Valid LLM-emitted decision types (ADR 009 surface values).
const LLMDecisionTypeSchema = z.enum([
  'probe_deeper',
  'pivot_related',
  'move_on',
  'circle_back',
  'flag_out_of_scope',
  'close_interview',
]);

const CoverageUpdateSchema = z.object({
  questionId: z.string(),
  status: CoverageStatusSchema,
  confidence: CoverageConfidenceSchema,
  summary: z.string(),
});

const FlaggedItemSchema = z.object({
  description: z.string(),
  priority: FlaggedItemPrioritySchema,
  suggestedTags: z.array(z.string()),
});

const StateUpdateSchema = z.object({
  decisionType: LLMDecisionTypeSchema,
  sourceQuestionId: z.string().nullable(),
  targetQuestionId: z.string().nullable(),
  reasoning: z.string(),
  coverageUpdates: z.array(CoverageUpdateSchema).default([]),
  flaggedItems: z.array(FlaggedItemSchema).default([]),
});

// ---------------------------------------------------------------------------
// parseStateUpdate
//
// @param accumulatedText   The full raw text accumulated from the LLM stream.
// @param knownQuestionIds  Set of question UUIDs belonging to this template.
//                          Used to validate sourceQuestionId, targetQuestionId,
//                          and every coverageUpdates[*].questionId.
// ---------------------------------------------------------------------------
export function parseStateUpdate(
  accumulatedText: string,
  knownQuestionIds: Set<string>,
): ParseResult {
  // --- Step 1: Split on delimiters -------------------------------------------
  const startIdx = accumulatedText.indexOf(DELIMITER_START);

  if (startIdx === -1) {
    return {
      ok: false,
      conversational: accumulatedText,
      errorType: 'missing_block',
    };
  }

  // Everything before the start delimiter is the conversational portion.
  const conversational = accumulatedText.slice(0, startIdx);

  const afterStart = accumulatedText.slice(startIdx + DELIMITER_START.length);
  const endIdx = afterStart.indexOf(DELIMITER_END);

  // If ---END_STATE_UPDATE--- is missing, treat as missing_block as well —
  // the block is incomplete/truncated and cannot be parsed safely.
  const rawBlock = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);

  // --- Step 2: JSON parse -----------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock.trim());
  } catch {
    return {
      ok: false,
      conversational,
      errorType: 'invalid_json',
    };
  }

  // --- Step 3: Zod schema validation ------------------------------------------
  const validated = StateUpdateSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      conversational,
      errorType: 'schema_mismatch',
    };
  }

  const raw = validated.data;

  // --- Step 4: Validate question IDs ------------------------------------------
  let unknownCount = 0;

  // sourceQuestionId: null it out if unknown (not a hard failure).
  const sourceQuestionId =
    raw.sourceQuestionId !== null && !knownQuestionIds.has(raw.sourceQuestionId)
      ? (unknownCount++, null)
      : raw.sourceQuestionId;

  // targetQuestionId: null it out if unknown.
  const targetQuestionId =
    raw.targetQuestionId !== null && !knownQuestionIds.has(raw.targetQuestionId)
      ? (unknownCount++, null)
      : raw.targetQuestionId;

  // coverageUpdates: drop entries with unknown questionId, collect count.
  const validCoverageUpdates: CoverageUpdate[] = [];
  for (const entry of raw.coverageUpdates) {
    if (knownQuestionIds.has(entry.questionId)) {
      validCoverageUpdates.push(entry);
    } else {
      unknownCount++;
    }
  }

  const stateUpdate: StateUpdate = {
    decisionType: raw.decisionType as LLMDecisionType,
    sourceQuestionId,
    targetQuestionId,
    reasoning: raw.reasoning,
    coverageUpdates: validCoverageUpdates,
    flaggedItems: raw.flaggedItems,
  };

  // Any unknowns found → partial result so caller can emit telemetry but
  // still apply the surviving (valid) entries.
  if (unknownCount > 0) {
    return {
      ok: 'partial',
      conversational,
      stateUpdate,
      errorType: 'unknown_question_id',
      unknownQuestionIdCount: unknownCount,
    };
  }

  return {
    ok: true,
    conversational,
    stateUpdate,
  };
}
