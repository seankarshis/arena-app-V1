// ---------------------------------------------------------------------------
// Arena Interview Session State — shared v2-coverage types
//
// This module is the single source of truth for the `v2-coverage` Redis session
// shape defined in `conversation-protocol-spec-v4.md` §5. Both the prompt
// builder (read-only consumer) and the state manager (mutator) import from
// here so the type is defined once.
//
// NOTE: The legacy `v1-pool` session shape lives in `./session.ts`
// (`InterviewSession`). Existing in-flight sessions at deploy time carry
// `sessionVersion ?? 'v1-pool'` and route through the pool-based path until
// they drain via the 4h Redis TTL (per ADR 008).
// ---------------------------------------------------------------------------

import type {
  CoverageStatus,
  CoverageConfidence,
} from '../observability/events';

// ---------------------------------------------------------------------------
// Per-turn & history types
// ---------------------------------------------------------------------------

/** A single conversational turn in the messages array (Anthropic SDK shape). */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Enrichment & context types
// ---------------------------------------------------------------------------

/** A single entry in the facts ledger — compact factual recall from prior turns. */
export interface FactsLedgerEntry {
  id: string;
  text: string;
  sourceTurn: number;
  questionIds: string[];
}

/** An active conversational thread not yet resolved. */
export interface ActiveThread {
  topic: string;
  openedAtTurn: number;
  questionIds: string[];
}

// ---------------------------------------------------------------------------
// Coverage map types
// ---------------------------------------------------------------------------

/** Per-question coverage state in the coverage map. */
export interface CoverageEntry {
  status: CoverageStatus;
  confidence: CoverageConfidence | null;
  turnNumbers: number[];
  summary: string | null;
}

// ---------------------------------------------------------------------------
// Template-question carried into the session
// ---------------------------------------------------------------------------

/**
 * A template-question as carried into the interview session — the data the
 * prompt builder needs for each question in the guide.
 */
export interface SessionQuestion {
  /** Matches TemplateQuestion.questionId / Question.id */
  questionId: string;
  /** Question.text — the actual question wording */
  questionText: string;
  /** TemplateQuestion.categoryBucket */
  categoryBucket: string;
  /** TemplateQuestion.isRequired */
  isRequired: boolean;
  /** TemplateQuestion.sequenceOrder — used for rendering order */
  sequenceOrder: number;
  /** Question.sensitivityLevel: 'standard' | 'sensitive' | 'highly_sensitive' */
  sensitivityLevel: 'standard' | 'sensitive' | 'highly_sensitive';
  /** Question.intent — may be null; falls back to ADR 006 phrasing when absent */
  intent: string | null;
  /** TemplateQuestion.adminNotes — may be null */
  adminNotes: string | null;
  /** Tag labels associated with this question */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Full v2-coverage session state
// ---------------------------------------------------------------------------

/**
 * Full interview session state for the v2-coverage orchestration path.
 * Reflects the v2-coverage Redis session shape from
 * conversation-protocol-spec-v4.md §5.
 */
export interface InterviewSessionState {
  // --- Identity ---
  interviewId: string;
  userId: string;
  templateId: string;

  // --- Orchestration control ---
  turnNumber: number;
  isStreaming: boolean;
  /** The LLM text from the current (or most recent) turn, used for snapshot. */
  currentTurnLlmText: string;
  /** Migration gate: v1-pool = legacy deterministic queue; v2-coverage = new orchestration. */
  sessionVersion: 'v1-pool' | 'v2-coverage';
  /** Resets to 0 on any successful state-update parse. */
  consecutiveParseFailures: number;

  // --- Coverage map (keyed by questionId) ---
  coverage: Record<string, CoverageEntry>;

  // --- Enrichment & context ---
  activeThreads: ActiveThread[];
  factsLedger: FactsLedgerEntry[];
  rapportNotes: string[];

  // --- Interview guide (loaded at session start from DB) ---
  questions: SessionQuestion[];

  // --- Interviewee context (from template / user record at session start) ---
  intervieweeName: string;      // first name only
  intervieweeRole: string;
  intervieweeCompany: string;
  templateFocus: string;        // one-line template purpose / focus statement

  // --- Template-specific system prompt override (from InterviewTemplate.systemPrompt) ---
  /** Null when the template has no override. Appended after Tier 2 guide content. */
  templateSystemPromptOverride: string | null;

  // --- Conversation history (last N turns as message pairs) ---
  /** Alternating user/assistant messages, oldest first. */
  conversationHistory: AnthropicMessage[];

  // --- Current interviewee utterance ---
  /** The message just received — appended as the final user message. */
  currentUserUtterance: string;
}
