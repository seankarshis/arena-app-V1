// ---------------------------------------------------------------------------
// Arena Per-Turn State Manager
//
// This module is dual-path during the v1-pool → v2-coverage migration window
// (ADR 008). Two families of operations coexist:
//
//   1. Legacy pool-based operations (DEPRECATED — kept only so existing
//      in-flight v1-pool sessions can drain naturally via the 4h Redis TTL).
//      These operate on the legacy `InterviewSession` shape in `./session.ts`.
//
//   2. New coverage-map operations — the v2-coverage path. These operate on
//      the `InterviewSessionState` shape in `./sessionState.ts`. They return
//      transition records that `submitResponse` (M2d) uses to emit
//      `coverage_transitions` telemetry.
//
// The `getSessionVersion` helper is the routing switch: sessions missing the
// `sessionVersion` field default to 'v1-pool' so legacy sessions continue on
// the deprecated code path. New sessions built via `buildInitialSession`
// carry 'v2-coverage' and route to the new operations.
//
// Atomic turn lock (`isStreaming`) is untouched by this module — lock
// acquisition and release live in the interview engine.
//
// IMPORTANT: this module does not call `clickHouseWrite` or emit telemetry.
// The caller (`submitResponse`) owns event emission and passes the returned
// transitions/items into the observability emitters.
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import type { InterviewSession, TriggeredFollowup } from './session';
import type {
  CoverageEntry,
  InterviewSessionState,
  SessionQuestion,
} from './sessionState';
import type {
  CoverageUpdate,
  FlaggedItem,
} from './stateUpdateParser';
import type {
  CoverageConfidence,
  CoverageStatus,
} from '../observability/events';

// ---------------------------------------------------------------------------
// Legacy (v1-pool) public types — retained for in-flight sessions.
// ---------------------------------------------------------------------------

/** @deprecated v1-pool trigger shape. Triggers are now prose in adminNotes. */
export interface FollowupTrigger {
  condition: string;
  followupQuestionId: string;
}

/** @deprecated v1-pool template-question reference. */
export interface TemplateQuestionRef {
  questionId: string;
  text: string;
  categoryBucket: string;
  followupTriggers: FollowupTrigger[];
}

/** @deprecated v1-pool turn context. The v2 path builds the guide in promptBuilder. */
export interface TurnContext {
  questionsAskedSoFar: { questionId: string; text: string }[];
  bucketsCovered: Record<string, number>;
  underrepresentedBuckets: string[];
  requiredRemaining: { questionId: string; text: string }[];
  optionalRemaining: { questionId: string; text: string }[];
  currentQuestionTriggers: FollowupTrigger[];
  questionsAskedCount: number;
  totalExpectedQuestions: number;
}

// ---------------------------------------------------------------------------
// Legacy (v1-pool) state-update functions.
// @deprecated use coverage-map operations; retained for in-flight v1-pool
// sessions until they drain (one release).
// ---------------------------------------------------------------------------

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function applyQuestionAsked(
  session: InterviewSession,
  questionId: string,
  categoryBucket: string,
): Partial<InterviewSession> {
  return {
    questionsAsked: [...session.questionsAsked, questionId],
    bucketsCovered: {
      ...session.bucketsCovered,
      [categoryBucket]: (session.bucketsCovered[categoryBucket] ?? 0) + 1,
    },
    requiredRemaining: session.requiredRemaining.filter(
      (id) => id !== questionId,
    ),
    optionalRemaining: session.optionalRemaining.filter(
      (id) => id !== questionId,
    ),
  };
}

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function applyResponseSubmitted(
  session: InterviewSession,
  now?: string,
): Partial<InterviewSession> {
  return {
    questionsCompleted: session.questionsCompleted + 1,
    currentTranscriptBuffer: '',
    currentDrafts: [],
    lastActivityAt: now ?? new Date().toISOString(),
    idleWarningShown: false,
  };
}

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function applyQuestionSkipped(
  session: InterviewSession,
  questionId: string,
  categoryBucket: string,
  now?: string,
): Partial<InterviewSession> {
  return {
    questionsSkipped: [...session.questionsSkipped, questionId],
    bucketsCovered: {
      ...session.bucketsCovered,
      [categoryBucket]: (session.bucketsCovered[categoryBucket] ?? 0) + 1,
    },
    requiredRemaining: session.requiredRemaining.filter(
      (id) => id !== questionId,
    ),
    optionalRemaining: session.optionalRemaining.filter(
      (id) => id !== questionId,
    ),
    questionsCompleted: session.questionsCompleted + 1,
    lastActivityAt: now ?? new Date().toISOString(),
    idleWarningShown: false,
  };
}

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function applyFollowupTriggered(
  session: InterviewSession,
  triggeredByQuestionId: string,
  suggestedFollowupIds: string[],
): Partial<InterviewSession> {
  const entry: TriggeredFollowup = {
    triggeredBy: triggeredByQuestionId,
    suggested: suggestedFollowupIds,
  };
  return {
    triggeredFollowups: [...session.triggeredFollowups, entry],
  };
}

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function buildTurnContext(
  session: InterviewSession,
  questionMap: Map<string, TemplateQuestionRef>,
  currentQuestionId: string,
): TurnContext {
  const questionsAskedSoFar = session.questionsAsked
    .map((id) => {
      const q = questionMap.get(id);
      return q ? { questionId: id, text: q.text } : null;
    })
    .filter(
      (q): q is { questionId: string; text: string } => q !== null,
    );

  const bucketsCovered = { ...session.bucketsCovered };

  const counts = Object.values(bucketsCovered);
  const avg =
    counts.length > 0
      ? counts.reduce((sum, c) => sum + c, 0) / counts.length
      : 0;
  const underrepresentedBuckets = Object.entries(bucketsCovered)
    .filter(([, count]) => count < avg)
    .map(([bucket]) => bucket);

  const requiredRemaining = session.requiredRemaining
    .map((id) => {
      const q = questionMap.get(id);
      return q ? { questionId: id, text: q.text } : null;
    })
    .filter(
      (q): q is { questionId: string; text: string } => q !== null,
    );

  const optionalRemaining = session.optionalRemaining
    .map((id) => {
      const q = questionMap.get(id);
      return q ? { questionId: id, text: q.text } : null;
    })
    .filter(
      (q): q is { questionId: string; text: string } => q !== null,
    );

  const currentQuestion = questionMap.get(currentQuestionId);
  const currentQuestionTriggers = currentQuestion
    ? currentQuestion.followupTriggers
    : [];

  return {
    questionsAskedSoFar,
    bucketsCovered,
    underrepresentedBuckets,
    requiredRemaining,
    optionalRemaining,
    currentQuestionTriggers,
    questionsAskedCount: session.questionsAsked.length,
    totalExpectedQuestions: session.totalExpectedQuestions,
  };
}

/**
 * @deprecated use coverage-map operations; retained for in-flight v1-pool
 * sessions until they drain (one release).
 */
export function formatTurnContext(context: TurnContext): string {
  const lines: string[] = [];

  lines.push('## Interview Progress');
  lines.push(
    `Questions asked: ${context.questionsAskedCount} / ${context.totalExpectedQuestions}`,
  );
  lines.push('');

  if (context.questionsAskedSoFar.length > 0) {
    lines.push('### Questions Asked So Far');
    for (const q of context.questionsAskedSoFar) {
      lines.push(`- [${q.questionId}] ${q.text}`);
    }
    lines.push('');
  }

  lines.push('### Category Coverage');
  for (const [bucket, count] of Object.entries(context.bucketsCovered)) {
    const marker = context.underrepresentedBuckets.includes(bucket)
      ? ' (underrepresented)'
      : '';
    lines.push(`- ${bucket}: ${count} question(s)${marker}`);
  }
  lines.push('');

  if (context.requiredRemaining.length > 0) {
    lines.push('### Remaining Required Questions');
    for (const q of context.requiredRemaining) {
      lines.push(`- [${q.questionId}] ${q.text}`);
    }
    lines.push('');
  }

  if (context.optionalRemaining.length > 0) {
    lines.push('### Remaining Optional Questions');
    for (const q of context.optionalRemaining) {
      lines.push(`- [${q.questionId}] ${q.text}`);
    }
    lines.push('');
  }

  if (context.currentQuestionTriggers.length > 0) {
    lines.push('### Follow-Up Triggers for Current Question');
    lines.push("Evaluate these against the user's response:");
    for (const trigger of context.currentQuestionTriggers) {
      lines.push(
        `- ${trigger.condition} → suggest follow-up ${trigger.followupQuestionId}`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// v2-coverage types (exported so M2d / tests can consume them).
// ---------------------------------------------------------------------------

/**
 * A narrow session shape the coverage-map operations consume. Compatible with
 * both the full `InterviewSessionState` (new sessions) and the legacy
 * `InterviewSession` extended with v2 fields (transitional sessions).
 */
export interface CoverageCapableSession {
  coverage: Record<string, CoverageEntry>;
  activeThreads: InterviewSessionState['activeThreads'];
  factsLedger: InterviewSessionState['factsLedger'];
  rapportNotes: string[];
  sessionVersion?: 'v1-pool' | 'v2-coverage';
  consecutiveParseFailures: number;
}

/** One coverage-entry transition, ready for the `coverage_transitions` emitter. */
export interface CoverageTransition {
  questionId: string;
  oldStatus: CoverageStatus;
  /** null when there was no prior confidence (i.e. first write from not_started). */
  oldConfidence: CoverageConfidence | null;
  newStatus: CoverageStatus;
  newConfidence: CoverageConfidence;
  /** The summary text written by the LLM for this transition (may be ''). */
  summary: string;
}

/** A flagged_items row as persisted, returned for telemetry emission. */
export interface PersistedFlaggedItem {
  id: string;
  interviewId: string;
  sourceTurn: number;
  description: string;
  suggestedTags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/** Minimal template shape required by `evaluateCompletion`. */
export interface EvaluateCompletionTemplate {
  questions: Pick<SessionQuestion, 'questionId' | 'isRequired'>[];
}

// ---------------------------------------------------------------------------
// v2-coverage operations
// ---------------------------------------------------------------------------

/**
 * Apply a batch of coverage updates to the session's coverage map.
 *
 * Returns the new coverage map plus an array of transition records — one per
 * applied update — that the caller uses to emit `coverage_transitions` events.
 * Never mutates the input session.
 *
 * An update for a questionId not previously in the map is treated as a write
 * from `'not_started'` with `oldConfidence: null`. The `turnNumbers` array is
 * appended with the current turn number.
 */
export function applyCoverageUpdates<S extends { coverage: Record<string, CoverageEntry> }>(
  session: S,
  updates: CoverageUpdate[],
  turnNumber: number,
): { newCoverage: Record<string, CoverageEntry>; transitions: CoverageTransition[] } {
  const newCoverage: Record<string, CoverageEntry> = { ...session.coverage };
  const transitions: CoverageTransition[] = [];

  for (const update of updates) {
    const prior = session.coverage[update.questionId];
    const oldStatus: CoverageStatus = prior?.status ?? 'not_started';
    const oldConfidence: CoverageConfidence | null = prior?.confidence ?? null;

    const nextTurnNumbers = prior ? [...prior.turnNumbers, turnNumber] : [turnNumber];

    const nextEntry: CoverageEntry = {
      status: update.status,
      confidence: update.confidence,
      turnNumbers: nextTurnNumbers,
      summary: update.summary,
    };

    newCoverage[update.questionId] = nextEntry;

    transitions.push({
      questionId: update.questionId,
      oldStatus,
      oldConfidence,
      newStatus: update.status,
      newConfidence: update.confidence,
      summary: update.summary,
    });
  }

  return { newCoverage, transitions };
}

/**
 * Persist a batch of flagged items to the Postgres `flagged_items` table.
 *
 * Returns the persisted rows (including the generated `id` that the caller
 * passes to the `flagged_items` ClickHouse emitter as `flaggedItemId`).
 *
 * Priority mapping is identity: the parser enforces the closed enum.
 */
export async function applyFlaggedItems(
  prisma: PrismaClient,
  interviewId: string,
  sourceTurn: number,
  items: FlaggedItem[],
): Promise<PersistedFlaggedItem[]> {
  if (items.length === 0) return [];

  const persisted: PersistedFlaggedItem[] = [];

  // Parser emits lowercase priority values; Prisma enum values are uppercase
  // (with @map to the lowercase DB form). Normalize at the boundary.
  const PRIORITY_TO_PRISMA = {
    low: 'LOW',
    medium: 'MEDIUM',
    high: 'HIGH',
    critical: 'CRITICAL',
  } as const;

  for (const item of items) {
    const row = await prisma.flaggedItem.create({
      data: {
        interviewId,
        sourceTurn,
        description: item.description,
        suggestedTags: item.suggestedTags,
        priority: PRIORITY_TO_PRISMA[item.priority],
        needsAdminReview: true,
      },
    });

    persisted.push({
      id: row.id,
      interviewId: row.interviewId,
      sourceTurn: row.sourceTurn,
      description: row.description,
      suggestedTags: item.suggestedTags,
      priority: item.priority,
    });
  }

  return persisted;
}

/**
 * Mark a single question as skipped in the coverage map.
 *
 * Preserves any prior `summary` so the LLM's prior understanding is retained;
 * sets `status: 'skipped'` and records the turn in `turnNumbers`. Confidence
 * is set to `null` for skipped entries (no claim about coverage quality).
 *
 * Returns a new session object — never mutates the input.
 */
export function markQuestionSkipped<S extends CoverageCapableSession>(
  session: S,
  questionId: string,
  turnNumber: number,
): S {
  const prior = session.coverage[questionId];
  const nextEntry: CoverageEntry = {
    status: 'skipped',
    confidence: null,
    turnNumbers: prior ? [...prior.turnNumbers, turnNumber] : [turnNumber],
    summary: prior?.summary ?? null,
  };

  return {
    ...session,
    coverage: {
      ...session.coverage,
      [questionId]: nextEntry,
    },
  };
}

/**
 * Increment the consecutive parse-failure counter. The caller checks the
 * threshold (3) to trigger fallback synthesis per conversation-protocol-v4 §4.
 */
export function incrementParseFailures<S extends CoverageCapableSession>(session: S): S {
  return {
    ...session,
    consecutiveParseFailures: (session.consecutiveParseFailures ?? 0) + 1,
  };
}

/**
 * Reset the consecutive parse-failure counter to 0. Call on any successful
 * parse (including `'partial'` results — some entries survived).
 */
export function resetParseFailures<S extends CoverageCapableSession>(session: S): S {
  return {
    ...session,
    consecutiveParseFailures: 0,
  };
}

/**
 * Evaluate whether the interview satisfies the completion criterion.
 *
 * Returns `isComplete: true` only when every required question is either:
 *   - `'fully_covered'` with `confidence` in {'medium', 'high'}, or
 *   - `'skipped'`
 *
 * Otherwise, `gapReasons` enumerates each required question that failed the
 * check, one short sentence per reason. Reasons are for telemetry/logging
 * only — they are never shown to the interviewee.
 *
 * Optional questions are irrelevant to completion. They are not inspected.
 */
export function evaluateCompletion(
  session: { coverage: Record<string, CoverageEntry> },
  template: EvaluateCompletionTemplate,
): { isComplete: boolean; gapReasons: string[] } {
  const gapReasons: string[] = [];

  for (const q of template.questions) {
    if (!q.isRequired) continue;

    const entry = session.coverage[q.questionId];
    if (!entry || entry.status === 'not_started') {
      gapReasons.push(
        `Required question ${q.questionId} is not_started`,
      );
      continue;
    }

    if (entry.status === 'skipped') continue;

    if (entry.status === 'partially_covered') {
      gapReasons.push(
        `Required question ${q.questionId} is partially_covered (confidence ${entry.confidence ?? 'null'})`,
      );
      continue;
    }

    // status === 'fully_covered'
    if (entry.confidence === 'low' || entry.confidence === null) {
      gapReasons.push(
        `Required question ${q.questionId} is fully_covered but confidence is ${entry.confidence ?? 'null'}`,
      );
      continue;
    }
    // medium / high → passes
  }

  return { isComplete: gapReasons.length === 0, gapReasons };
}

/**
 * Return the session version, defaulting to 'v1-pool' when the field is
 * missing. This is the routing switch the interview engine uses to pick the
 * legacy pool-based path vs the new coverage-map path.
 */
export function getSessionVersion(
  session: { sessionVersion?: 'v1-pool' | 'v2-coverage' },
): 'v1-pool' | 'v2-coverage' {
  return session.sessionVersion ?? 'v1-pool';
}

// ---------------------------------------------------------------------------
// Resume reconstruction
// ---------------------------------------------------------------------------

/**
 * Minimal InterviewResponse row shape needed for reconstruction. Prisma's
 * generated type is strictly wider; this narrow interface lets callers (and
 * tests) pass any compatible shape.
 */
export interface ResponseRowForReconstruction {
  questionId: string;
  sequenceNumber: number;
  isSkipped: boolean;
}

/**
 * Rebuild a v2-coverage session's coverage map from persisted
 * `interview_responses` when the Redis session has expired mid-interview.
 *
 * Per conversation-protocol-spec-v4 §10: answered questions are seeded at
 * `'partially_covered'` with `confidence: 'medium'` as a conservative
 * default — the LLM refines on the first post-resume turn. Skipped responses
 * set `status: 'skipped'`. Facts ledger, active threads, and rapport notes
 * reconstruct as empty and repopulate asynchronously (Phase 4).
 *
 * This helper returns only the fields that reconstruction can derive from
 * Postgres. The caller merges this with the interviewee/template context
 * (`intervieweeName`, `templateFocus`, `questions`, etc.) before persisting
 * the session back to Redis.
 */
export async function reconstructSessionFromResponses(
  prisma: PrismaClient,
  interviewId: string,
): Promise<{
  coverage: Record<string, CoverageEntry>;
  activeThreads: [];
  factsLedger: [];
  rapportNotes: [];
  consecutiveParseFailures: 0;
  sessionVersion: 'v2-coverage';
  turnNumber: number;
}> {
  const responses = await prisma.interviewResponse.findMany({
    where: { interviewId },
    orderBy: { sequenceNumber: 'asc' },
    select: {
      questionId: true,
      sequenceNumber: true,
      isSkipped: true,
    },
  });

  const coverage: Record<string, CoverageEntry> = {};

  for (const row of responses as ResponseRowForReconstruction[]) {
    const existing = coverage[row.questionId];
    const turnNumbers = existing
      ? [...existing.turnNumbers, row.sequenceNumber]
      : [row.sequenceNumber];

    if (row.isSkipped) {
      coverage[row.questionId] = {
        status: 'skipped',
        confidence: null,
        turnNumbers,
        summary: existing?.summary ?? null,
      };
    } else {
      coverage[row.questionId] = {
        status: 'partially_covered',
        confidence: 'medium',
        turnNumbers,
        summary: null,
      };
    }
  }

  const highestSeq =
    responses.length > 0
      ? Math.max(...responses.map((r: ResponseRowForReconstruction) => r.sequenceNumber))
      : 0;

  return {
    coverage,
    activeThreads: [],
    factsLedger: [],
    rapportNotes: [],
    consecutiveParseFailures: 0,
    sessionVersion: 'v2-coverage',
    turnNumber: highestSeq,
  };
}
