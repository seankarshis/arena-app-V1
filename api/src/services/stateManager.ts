// ---------------------------------------------------------------------------
// Arena Per-Turn State Manager — Pure Functions
// Computes updated session state after each LLM turn and builds per-turn
// context for the LLM. No infrastructure dependencies.
// ---------------------------------------------------------------------------

import type { InterviewSession, TriggeredFollowup } from './session';

// --- Types ---

export interface FollowupTrigger {
  condition: string;
  followupQuestionId: string;
}

export interface TemplateQuestionRef {
  questionId: string;
  text: string;
  categoryBucket: string;
  followupTriggers: FollowupTrigger[];
}

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

// --- State update functions (return partial patches for the session) ---

/** Compute session patch after the LLM delivers a question. */
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

/** Compute session patch after a user submits a response. */
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

/** Compute session patch after a user skips a question. */
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

/** Record a follow-up trigger activation (for analytics). */
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

// --- Turn context ---

/**
 * Build a structured per-turn context from the current session state.
 *
 * The context includes:
 * - Questions asked so far (IDs and text)
 * - Category bucket coverage with underrepresented buckets flagged
 * - Remaining required and optional questions
 * - Follow-up trigger definitions for the most recently asked question
 * - Running question count vs expected total
 *
 * The raw trigger definitions are passed through — the LLM evaluates them,
 * NOT the application.
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

  // Underrepresented: buckets below the average coverage count
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

/** Format a TurnContext as a text block for inclusion in LLM messages. */
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
