// ---------------------------------------------------------------------------
// Arena Observability — named emitter functions for the five orchestration-loop
// event types introduced in ADR 014.
//
// All emitters:
//   - Call clickHouseWrite() — the ONLY write path (never raw HTTP or SQL)
//   - Let sanitizeForLog() handle pseudonymization (auto-applied inside clickHouseWrite)
//   - Are fire-and-forget (void return, no await)
//   - Never include PII: no text content, no summaries, no tag values, no raw errors
// ---------------------------------------------------------------------------

import { clickHouseWrite } from './clickhouseWriter';

// ---------------------------------------------------------------------------
// Closed enum types
// ---------------------------------------------------------------------------

export type OrchestrationDecisionType =
  | 'probe_deeper'
  | 'pivot_related'
  | 'move_on'
  | 'circle_back'
  | 'flag_out_of_scope'
  | 'close_interview'
  | 'fallback';

export type CoverageStatus = 'not_started' | 'partially_covered' | 'fully_covered' | 'skipped';

export type CoverageConfidence = 'low' | 'medium' | 'high';

export type EnrichmentStatus = 'started' | 'succeeded' | 'failed' | 'retried';

export type EnrichmentJobType = 'enrichment';

export type EnrichmentErrorCode =
  | 'llm_timeout'
  | 'llm_error'
  | 'invalid_response'
  | 'db_write_failed'
  | 'tag_limit_exceeded'
  | 'unknown';

export type FlaggedItemPriority = 'low' | 'medium' | 'high' | 'critical';

export type ParseErrorType =
  | 'missing_block'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'unknown_question_id';

// Runtime validation sets for closed enums — used to catch invalid values at
// the function boundary that the TypeScript type system cannot catch at runtime
// (e.g., values coming from JSON parsing or external services).

const VALID_ENRICHMENT_ERROR_CODES = new Set<EnrichmentErrorCode>([
  'llm_timeout',
  'llm_error',
  'invalid_response',
  'db_write_failed',
  'tag_limit_exceeded',
  'unknown',
]);

const VALID_PARSE_ERROR_TYPES = new Set<ParseErrorType>([
  'missing_block',
  'invalid_json',
  'schema_mismatch',
  'unknown_question_id',
]);

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

export interface OrchestrationDecisionParams {
  interviewId: string;
  templateId: string;
  turnNumber: number;
  decisionType: OrchestrationDecisionType;
  sourceQuestionId: string;
  /** Empty string if the bot is not transitioning to a specific question. */
  targetQuestionId: string;
  openQuestionCount: number;
  activeThreadCount: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  model: string;
}

export interface CoverageTransitionParams {
  interviewId: string;
  questionId: string;
  templateId: string;
  oldStatus: CoverageStatus;
  newStatus: CoverageStatus;
  /** null when no previous confidence value existed. */
  oldConfidence: CoverageConfidence | null;
  newConfidence: CoverageConfidence;
  turnNumber: number;
  /**
   * Whether a summary string was present in the coverage update.
   * NEVER pass the summary itself — only this boolean and summaryLength.
   */
  hasSummary: boolean;
  /** Character count of the summary string; 0 when hasSummary is false. */
  summaryLength: number;
}

export interface EnrichmentJobParams {
  responseId: string;
  interviewId: string;
  jobType: EnrichmentJobType;
  status: EnrichmentStatus;
  attemptNumber: number;
  retryCount: number;
  /** Wall-clock ms including retries; meaningful on terminal statuses. */
  durationMs: number;
  /**
   * CLOSED ENUM — never populate from err.message or any user-derived string.
   * Required when status is 'failed'; optional otherwise.
   */
  errorCode?: EnrichmentErrorCode;
  /** Present when status is 'succeeded'. */
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  entityCount?: number;
  tagCount?: number;
}

export interface FlaggedItemParams {
  /** Postgres row ID — pseudonymized by sanitizeForLog for ClickHouse→Postgres correlation. */
  flaggedItemId: string;
  interviewId: string;
  templateId: string;
  sourceTurn: number;
  priority: FlaggedItemPriority;
  /** Count of suggested tags — never the tag values themselves. */
  suggestedTagCount: number;
  /** Character count of the description — never the description text itself. */
  descriptionLength: number;
}

export interface StateParseFailureParams {
  interviewId: string;
  turnNumber: number;
  parseErrorType: ParseErrorType;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Count of unrecognized question IDs; relevant when parseErrorType is 'unknown_question_id'. */
  unknownQuestionIdCount?: number;
  /** True if some valid entries were applied despite the parse failure. */
  partialApplied: boolean;
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Emit one event per turn after the structured-output block is parsed.
 *
 * Severity: WARN when decisionType is 'fallback' (the bot could not produce a
 * valid decision and fell back to a safe default); INFO otherwise.
 *
 * Never includes question text, interviewee content, or summary strings.
 */
export function emitOrchestrationDecision(params: OrchestrationDecisionParams): void {
  const severity = params.decisionType === 'fallback' ? 'WARN' : 'INFO';

  clickHouseWrite(
    'orchestration_decisions',
    {
      interviewId: params.interviewId,
      templateId: params.templateId,
      turnNumber: params.turnNumber,
      decisionType: params.decisionType,
      sourceQuestionId: params.sourceQuestionId,
      targetQuestionId: params.targetQuestionId,
      openQuestionCount: params.openQuestionCount,
      activeThreadCount: params.activeThreadCount,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      latencyMs: params.latencyMs,
      model: params.model,
    },
    { severity },
  );
}

/**
 * Emit one event per coverage update applied from the structured-output block.
 *
 * Critical PII rule: never pass summary text. Only hasSummary (boolean) and
 * summaryLength (character count) are included. This is the canonical
 * "emit about the data, not the data" guardrail pattern.
 *
 * Severity: always INFO.
 */
export function emitCoverageTransition(params: CoverageTransitionParams): void {
  clickHouseWrite(
    'coverage_transitions',
    {
      interviewId: params.interviewId,
      questionId: params.questionId,
      templateId: params.templateId,
      oldStatus: params.oldStatus,
      newStatus: params.newStatus,
      oldConfidence: params.oldConfidence,
      newConfidence: params.newConfidence,
      turnNumber: params.turnNumber,
      hasSummary: params.hasSummary,
      summaryLength: params.summaryLength,
    },
    { severity: 'INFO' },
  );
}

/**
 * Emit on enrichment job start, success, failure, and each retry.
 *
 * Severity rules:
 *   - 'started' | 'retried'               → INFO
 *   - 'succeeded' with retryCount === 0   → INFO
 *   - 'succeeded' with retryCount > 0     → WARN
 *   - 'failed'                            → ERROR
 *
 * errorCode MUST be a member of the closed enum — never a raw exception message
 * or stack trace. The runtime guard throws immediately if an invalid value is
 * passed, ensuring cardinality is bounded in ClickHouse.
 *
 * Service name: 'arena-enrichment' — a dedicated registered service name.
 */
export function emitEnrichmentJob(params: EnrichmentJobParams): void {
  // Runtime validation of the closed enum — the TypeScript type alone cannot
  // catch invalid values that arrive via JSON parsing or dynamic construction.
  if (params.errorCode !== undefined && !VALID_ENRICHMENT_ERROR_CODES.has(params.errorCode)) {
    throw new Error(
      `[emitEnrichmentJob] Invalid errorCode: "${params.errorCode}". ` +
      `Must be one of: ${[...VALID_ENRICHMENT_ERROR_CODES].join(', ')}`,
    );
  }

  let severity: string;
  if (params.status === 'failed') {
    severity = 'ERROR';
  } else if (params.status === 'succeeded' && params.retryCount > 0) {
    severity = 'WARN';
  } else {
    severity = 'INFO';
  }

  const payload: Record<string, unknown> = {
    responseId: params.responseId,
    interviewId: params.interviewId,
    jobType: params.jobType,
    status: params.status,
    attemptNumber: params.attemptNumber,
    retryCount: params.retryCount,
    durationMs: params.durationMs,
  };

  if (params.errorCode !== undefined) payload.errorCode = params.errorCode;
  if (params.model !== undefined) payload.model = params.model;
  if (params.promptTokens !== undefined) payload.promptTokens = params.promptTokens;
  if (params.completionTokens !== undefined) payload.completionTokens = params.completionTokens;
  if (params.entityCount !== undefined) payload.entityCount = params.entityCount;
  if (params.tagCount !== undefined) payload.tagCount = params.tagCount;

  clickHouseWrite('enrichment_jobs', payload, {
    severity,
    serviceName: 'arena-enrichment',
  });
}

/**
 * Emit one event per flagged item created.
 *
 * Severity: INFO for low/medium, WARN for high, ERROR for critical.
 *
 * Critical PII rule: the description string and tag values NEVER leave Postgres.
 * Only descriptionLength (character count) and suggestedTagCount (integer) are
 * included. flaggedItemId is pseudonymized automatically by sanitizeForLog
 * (key contains 'id') to enable ClickHouse→Postgres row correlation without
 * exposing the raw Postgres ID.
 */
export function emitFlaggedItem(params: FlaggedItemParams): void {
  let severity: string;
  if (params.priority === 'critical') {
    severity = 'ERROR';
  } else if (params.priority === 'high') {
    severity = 'WARN';
  } else {
    severity = 'INFO'; // low | medium
  }

  clickHouseWrite(
    'flagged_items',
    {
      flaggedItemId: params.flaggedItemId,
      interviewId: params.interviewId,
      templateId: params.templateId,
      sourceTurn: params.sourceTurn,
      priority: params.priority,
      suggestedTagCount: params.suggestedTagCount,
      descriptionLength: params.descriptionLength,
    },
    { severity },
  );
}

/**
 * Emit whenever the structured-output parser falls back.
 *
 * Severity: always WARN. The conversation does not break — this is a
 * degradation signal, not a terminal failure. Use ERROR only if the interview
 * itself fails (which is tracked elsewhere via interview_lifecycle).
 *
 * parseErrorType MUST be a member of the closed enum. The runtime guard throws
 * immediately on an invalid value.
 *
 * PII rule: no raw LLM output, no interviewee content, no question text.
 * unknownQuestionIdCount is a COUNT — never the IDs themselves.
 */
export function emitStateParseFailure(params: StateParseFailureParams): void {
  // Runtime validation of the closed enum.
  if (!VALID_PARSE_ERROR_TYPES.has(params.parseErrorType)) {
    throw new Error(
      `[emitStateParseFailure] Invalid parseErrorType: "${params.parseErrorType}". ` +
      `Must be one of: ${[...VALID_PARSE_ERROR_TYPES].join(', ')}`,
    );
  }

  const payload: Record<string, unknown> = {
    interviewId: params.interviewId,
    turnNumber: params.turnNumber,
    parseErrorType: params.parseErrorType,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    partialApplied: params.partialApplied,
  };

  if (params.unknownQuestionIdCount !== undefined) {
    payload.unknownQuestionIdCount = params.unknownQuestionIdCount;
  }

  clickHouseWrite('state_parse_failures', payload, { severity: 'WARN' });
}
