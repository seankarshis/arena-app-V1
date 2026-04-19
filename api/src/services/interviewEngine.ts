// ---------------------------------------------------------------------------
// Arena Interview Engine — submitResponse, skipQuestion, completeInterview
//
// submitResponse is dual-path during the v1-pool → v2-coverage migration:
//
//   - Legacy v1-pool sessions go through `legacySubmitResponse` (unchanged
//     from the pool-based engine) — retained so in-flight sessions drain
//     naturally via the 4h Redis TTL per ADR 008.
//
//   - New v2-coverage sessions go through `submitResponseV2Coverage` which
//     implements the LLM-driven orchestration loop (ADR 008), structured
//     output parsing (ADR 009), context tiering & prompt caching (ADR 010),
//     live-vs-async split (ADR 011), and the five new ClickHouse event
//     types (ADR 014). See conversation-protocol-spec-v4.md §4 for the
//     authoritative step list.
//
// Dispatch happens inside submitResponse via getSessionVersion(session)
// after the atomic turn lock check. The lock acquisition/release code is
// untouched — both paths share the same lock semantics.
// ---------------------------------------------------------------------------

import { Prisma, type PrismaClient } from '@prisma/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  getSession,
  updateSession,
  deleteSession,
  type InterviewSession,
  type ConversationEntry,
} from './session';
import {
  applyResponseSubmitted,
  applyQuestionSkipped,
  applyQuestionAsked,
  buildTurnContext,
  formatTurnContext,
  applyCoverageUpdates,
  applyFlaggedItems,
  markQuestionSkipped,
  incrementParseFailures,
  resetParseFailures,
  evaluateCompletion,
  getSessionVersion,
  type TemplateQuestionRef,
  type FollowupTrigger,
  type CoverageTransition,
  type PersistedFlaggedItem,
  type EvaluateCompletionTemplate,
} from './stateManager';
import {
  buildSystemPrompt,
  type PromptTemplateData,
  type PromptQuestion,
} from './promptConstructor';
import { buildPrompt, type BuiltPrompt } from './promptBuilder';
import { parseStateUpdate, type StateUpdate } from './stateUpdateParser';
import type {
  AnthropicMessage,
  CoverageEntry,
  InterviewSessionState,
  SessionQuestion,
} from './sessionState';
import {
  emitOrchestrationDecision,
  emitCoverageTransition,
  emitFlaggedItem,
  emitStateParseFailure,
  type OrchestrationDecisionType,
} from '../observability/events';
import {
  notFound,
  invalidState,
  forbidden,
  validationError,
} from '../middleware/errors';
import { clickHouseWrite } from '../observability/clickhouseWriter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LLM_MODEL = 'claude-sonnet-4-20250514';
const MAX_LLM_TOKENS = 4096;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? 'arena-event-bus';
const PROMPT_VERSION = 'v1';
const STATE_UPDATE_DELIMITER = '---STATE_UPDATE---';
const MAX_CONSECUTIVE_PARSE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface ClaudeApiClient {
  chat(params: {
    system: string;
    messages: ClaudeMessage[];
    model?: string;
    maxTokens?: number;
  }): Promise<ClaudeChatResult>;
}

/**
 * A `system` block as passed to the Anthropic SDK's cache-control-capable
 * array form. Exactly one block carries `cache_control: { type: 'ephemeral' }`
 * at the Tier 1 → Tier 2 boundary per ADR 010.
 */
export interface ClaudeSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Streaming Claude client used by the v2-coverage path. Accumulates the full
 * response server-side, invoking `onPreDelimiterToken` only for tokens
 * arriving before the `---STATE_UPDATE---` marker. The caller uses that
 * stream of pre-delimiter text to drive SSE while the state block stays
 * server-side.
 */
export interface ClaudeStreamingResult {
  fullContent: string;
  /** The conversational portion with the delimiter and state block stripped. */
  preDelimiterContent: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface ClaudeStreamingClient {
  stream(params: {
    system: string | ClaudeSystemBlock[];
    messages: ClaudeMessage[];
    model?: string;
    maxTokens?: number;
    /**
     * Called for each token that arrives before the STATE_UPDATE delimiter.
     * Once the delimiter is detected the callback is never invoked again;
     * subsequent tokens accumulate silently in `fullContent`.
     */
    onPreDelimiterToken?: (token: string) => void;
  }): Promise<ClaudeStreamingResult>;
}

export interface EventPublisher {
  publish(params: {
    detailType: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
}

export interface SubmitResponseInput {
  interviewId: string;
  rawTranscription: string;
  inputMode: string;
}

export interface SubmitResponseResult {
  responseId: string;
  /** 'in_progress' | 'completed' — v2-coverage may close the interview via close_interview. */
  interviewStatus: string;
}

export interface SkipQuestionResult {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Allowed input modes
// ---------------------------------------------------------------------------

const VALID_INPUT_MODES = new Set(['voice', 'text', 'edited']);

// ---------------------------------------------------------------------------
// Factory: Claude API client (non-streaming, legacy v1-pool path)
// ---------------------------------------------------------------------------

export function createClaudeApiClient(apiKey: string): ClaudeApiClient {
  return {
    async chat({
      system,
      messages,
      model = DEFAULT_LLM_MODEL,
      maxTokens = MAX_LLM_TOKENS,
    }) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const start = Date.now();

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });

      const latencyMs = Date.now() - start;
      const textBlock = response.content.find((b) => b.type === 'text') as
        | { type: 'text'; text: string }
        | undefined;

      return {
        content: textBlock?.text ?? '',
        model: response.model,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        latencyMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: Claude streaming client (v2-coverage path)
//
// Wraps @anthropic-ai/sdk's streaming interface and performs incremental
// `---STATE_UPDATE---` detection:
//
//   * Each incoming token is appended to an accumulator buffer.
//   * While the delimiter has NOT yet been observed, the buffer is scanned
//     on every token. Bytes that are safely known to precede the delimiter
//     are flushed to `onPreDelimiterToken`. Bytes that could be the leading
//     portion of the delimiter are held back in a "pending" window so a
//     delimiter arriving mid-chunk never leaks to SSE.
//   * Once the delimiter is fully observed, any truly pre-delimiter text
//     that is still pending flushes one final time, then no further callback
//     invocations occur.
//   * `preDelimiterContent` captures everything before the delimiter as the
//     canonical conversational portion; `fullContent` keeps the raw stream
//     for server-side parsing.
// ---------------------------------------------------------------------------

export function createClaudeStreamingClient(apiKey: string): ClaudeStreamingClient {
  return {
    async stream({
      system,
      messages,
      model = DEFAULT_LLM_MODEL,
      maxTokens = MAX_LLM_TOKENS,
      onPreDelimiterToken,
    }) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const start = Date.now();
      let fullContent = '';

      // Incremental delimiter detector state.
      const detector = new DelimiterBoundaryDetector(STATE_UPDATE_DELIMITER);

      const anthropicStream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: system as unknown as Parameters<typeof client.messages.stream>[0]['system'],
        messages,
      });

      for await (const chunk of anthropicStream) {
        if (
          chunk.type === 'content_block_delta' &&
          (chunk.delta as { type: string }).type === 'text_delta'
        ) {
          const token = (chunk.delta as { text: string }).text;
          fullContent += token;

          const safeToEmit = detector.ingest(token);
          if (safeToEmit && onPreDelimiterToken) {
            onPreDelimiterToken(safeToEmit);
          }
        }
      }

      // Stream ended. If the delimiter was never seen, flush pending bytes.
      const tail = detector.flushIfNoDelimiter();
      if (tail && onPreDelimiterToken) {
        onPreDelimiterToken(tail);
      }

      const finalMessage = await anthropicStream.finalMessage();

      return {
        fullContent,
        preDelimiterContent: detector.getPreDelimiterContent(fullContent),
        model: finalMessage.model,
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        latencyMs: Date.now() - start,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: EventBridge publisher (production)
// ---------------------------------------------------------------------------

export function createEventPublisher(): EventPublisher {
  if (process.env.NODE_ENV !== 'production') {
    return { async publish() {} };
  }
  return {
    async publish({ detailType, detail }) {
      const client = new EventBridgeClient({
        region: process.env.AWS_REGION ?? 'us-east-2',
      });
      await client.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: 'arena.interview',
              DetailType: detailType,
              Detail: JSON.stringify(detail),
              EventBusName: EVENT_BUS_NAME,
            },
          ],
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// DelimiterBoundaryDetector
//
// Scans an incoming token stream for a fixed delimiter string. Emits the
// largest prefix of the accumulated buffer that CANNOT be the leading edge
// of the delimiter, holding the trailing `delimiter.length - 1` bytes in a
// pending window so a delimiter arriving mid-chunk never leaks through.
// ---------------------------------------------------------------------------

export class DelimiterBoundaryDetector {
  private buffer = '';
  private emittedLen = 0;
  private delimiterFound = false;
  private delimiterStartIdx = -1;

  constructor(private readonly delimiter: string) {}

  /**
   * Ingest `token`. Returns the next chunk of pre-delimiter text that is
   * safe to emit to SSE (may be empty string). Returns '' once the delimiter
   * has been observed — all subsequent tokens accumulate silently in the
   * caller's `fullContent`.
   */
  ingest(token: string): string {
    if (this.delimiterFound) {
      // Delimiter already seen; nothing more to emit.
      this.buffer += token;
      return '';
    }

    this.buffer += token;

    const delimIdx = this.buffer.indexOf(this.delimiter);
    if (delimIdx !== -1) {
      // Delimiter observed — emit any remaining pre-delimiter text in one flush.
      this.delimiterFound = true;
      this.delimiterStartIdx = delimIdx;
      if (delimIdx > this.emittedLen) {
        const toEmit = this.buffer.slice(this.emittedLen, delimIdx);
        this.emittedLen = delimIdx;
        return toEmit;
      }
      return '';
    }

    // Delimiter not yet seen. Hold back only the bytes that form the longest
    // suffix of the buffer that is a prefix of the delimiter — those bytes
    // could still grow into a full delimiter when the next token arrives.
    // Everything before that is safe to emit.
    const holdBack = this.longestSuffixPrefixOfDelimiter();
    const safeUpTo = this.buffer.length - holdBack;
    if (safeUpTo > this.emittedLen) {
      const toEmit = this.buffer.slice(this.emittedLen, safeUpTo);
      this.emittedLen = safeUpTo;
      return toEmit;
    }
    return '';
  }

  /**
   * Called once the upstream token stream has ended. If the delimiter was
   * never observed the entire buffer is conversational — return any bytes
   * that were still pending.
   */
  flushIfNoDelimiter(): string {
    if (this.delimiterFound) return '';
    const toEmit = this.buffer.slice(this.emittedLen);
    this.emittedLen = this.buffer.length;
    return toEmit;
  }

  /**
   * Returns the pre-delimiter portion of the full accumulated content —
   * the canonical conversational text stored as `questionTextAsAsked`.
   */
  getPreDelimiterContent(fullContent: string): string {
    if (!this.delimiterFound) return fullContent;
    return fullContent.slice(0, this.delimiterStartIdx);
  }

  /**
   * Returns the length of the longest suffix of `this.buffer` that is also
   * a prefix of `this.delimiter`. Those trailing bytes must be held back
   * because the next token could extend them into a full delimiter match.
   *
   * Only considers suffixes up to `delimiter.length - 1` — a full-length
   * suffix match would have been caught by indexOf above.
   */
  private longestSuffixPrefixOfDelimiter(): number {
    const maxLen = Math.min(this.buffer.length, this.delimiter.length - 1);
    for (let len = maxLen; len > 0; len--) {
      const suffix = this.buffer.slice(this.buffer.length - len);
      if (this.delimiter.startsWith(suffix)) {
        return len;
      }
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Internal: DB row types
// ---------------------------------------------------------------------------

interface TemplateQuestionRow {
  id: string;
  questionId: string;
  categoryBucket: string;
  isRequired: boolean;
  sequenceOrder: number;
  followupTriggers: unknown;
  adminNotes: string | null;
  question: {
    text: string;
    intent: string | null;
    sensitivityLevel: 'STANDARD' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
    questionTags: Array<{
      tag: { id: string; label: string };
    }>;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (shared between legacy + v2 paths)
// ---------------------------------------------------------------------------

/** Build a questionId → TemplateQuestionRef map from DB rows. */
function buildQuestionMap(rows: TemplateQuestionRow[]): Map<string, TemplateQuestionRef> {
  const map = new Map<string, TemplateQuestionRef>();
  for (const tq of rows) {
    const triggers = (
      Array.isArray(tq.followupTriggers) ? tq.followupTriggers : []
    ) as FollowupTrigger[];
    map.set(tq.questionId, {
      questionId: tq.questionId,
      text: tq.question.text,
      categoryBucket: tq.categoryBucket,
      followupTriggers: triggers,
    });
  }
  return map;
}

/** Find the last question the LLM asked from the conversation history. */
function getLastAskedQuestion(
  session: InterviewSession,
): { questionId: string; sequenceNumber: number } | null {
  for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
    const entry = session.conversationHistory[i];
    if (entry.role === 'assistant' && entry.questionId) {
      return {
        questionId: entry.questionId,
        sequenceNumber: entry.sequenceNumber ?? 1,
      };
    }
  }
  return null;
}

/**
 * Build the messages array for a Claude API call.
 * Ensures messages start with role 'user' (Anthropic API requirement).
 * Appends the new user content as the final message.
 */
function buildLlmMessages(
  history: ConversationEntry[],
  newUserContent: string,
): ClaudeMessage[] {
  const messages: ClaudeMessage[] = history.map((e) => ({
    role: e.role as 'user' | 'assistant',
    content: e.content,
  }));

  // Anthropic API requires messages to start with role 'user'
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: 'Please begin the interview.' });
  }

  messages.push({ role: 'user', content: newUserContent });
  return messages;
}

/** Fetch template + ordered template questions (with question text and tags). */
async function fetchTemplateContext(
  prisma: PrismaClient,
  templateId: string,
): Promise<{
  template: { id: string; name: string; description: string | null; systemPrompt: string | null };
  templateQuestions: TemplateQuestionRow[];
}> {
  const [template, templateQuestions] = await Promise.all([
    prisma.interviewTemplate.findUnique({ where: { id: templateId } }),
    prisma.templateQuestion.findMany({
      where: { templateId },
      include: {
        question: {
          include: { questionTags: { include: { tag: true } } },
        },
      },
      orderBy: { sequenceOrder: 'asc' },
    }),
  ]);

  if (!template) throw notFound('Template not found', { templateId });

  return {
    template,
    templateQuestions: templateQuestions as unknown as TemplateQuestionRow[],
  };
}

/** Convert DB rows into the PromptTemplateData shape for buildSystemPrompt (legacy). */
function buildPromptData(
  template: { name: string; description: string | null; systemPrompt: string | null },
  rows: TemplateQuestionRow[],
): PromptTemplateData {
  const questions: PromptQuestion[] = rows.map((tq) => ({
    questionId: tq.questionId,
    text: tq.question.text,
    categoryBucket: tq.categoryBucket,
    isRequired: tq.isRequired,
    sequenceOrder: tq.sequenceOrder,
    followupTriggers: (
      (Array.isArray(tq.followupTriggers) ? tq.followupTriggers : []) as FollowupTrigger[]
    ).map((t) => ({
      condition: t.condition,
      followupQuestionId: t.followupQuestionId,
    })),
  }));
  return { name: template.name, description: template.description, systemPrompt: template.systemPrompt, questions };
}

/** Returns the first question still remaining in the session (required first, then optional). */
function getNextQuestion(session: InterviewSession): string | null {
  return session.requiredRemaining[0] ?? session.optionalRemaining[0] ?? null;
}

// ---------------------------------------------------------------------------
// v2-coverage helpers
// ---------------------------------------------------------------------------

const PRISMA_TO_SENSITIVITY: Record<
  'STANDARD' | 'SENSITIVE' | 'HIGHLY_SENSITIVE',
  'standard' | 'sensitive' | 'highly_sensitive'
> = {
  STANDARD: 'standard',
  SENSITIVE: 'sensitive',
  HIGHLY_SENSITIVE: 'highly_sensitive',
};

/** Build the SessionQuestion[] that the prompt builder renders as the interview guide. */
function buildSessionQuestions(rows: TemplateQuestionRow[]): SessionQuestion[] {
  return rows.map((tq) => ({
    questionId: tq.questionId,
    questionText: tq.question.text,
    categoryBucket: tq.categoryBucket,
    isRequired: tq.isRequired,
    sequenceOrder: tq.sequenceOrder,
    sensitivityLevel: PRISMA_TO_SENSITIVITY[tq.question.sensitivityLevel] ?? 'standard',
    intent: tq.question.intent,
    adminNotes: tq.adminNotes,
    tags: tq.question.questionTags.map((qt) => qt.tag.label),
  }));
}

/**
 * Assemble the full v2 session state from the legacy InterviewSession (which
 * carries the v2 fields as optional) + the fetched template context + the
 * new user utterance. `currentUserUtterance` is the just-submitted transcription.
 */
function buildSessionStateForPrompt(params: {
  session: InterviewSession;
  templateName: string;
  templateDescription: string | null;
  templateSystemPrompt: string | null;
  sessionQuestions: SessionQuestion[];
  currentUserUtterance: string;
  intervieweeName: string;
}): InterviewSessionState {
  const coverage: Record<string, CoverageEntry> =
    params.session.coverage ?? {};

  return {
    interviewId: params.session.interviewId,
    userId: params.session.userId,
    templateId: params.session.templateId,
    turnNumber: params.session.questionsCompleted,
    isStreaming: params.session.isStreaming,
    currentTurnLlmText: params.session.currentTurnLlmText ?? '',
    sessionVersion: 'v2-coverage',
    consecutiveParseFailures: params.session.consecutiveParseFailures ?? 0,
    coverage,
    activeThreads: params.session.activeThreads ?? [],
    factsLedger: params.session.factsLedger ?? [],
    rapportNotes: params.session.rapportNotes ?? [],
    questions: params.sessionQuestions,
    intervieweeName: params.intervieweeName,
    intervieweeRole: '',
    intervieweeCompany: '',
    templateFocus: params.templateDescription ?? params.templateName,
    templateSystemPromptOverride: params.templateSystemPrompt,
    conversationHistory: params.session.conversationHistory.map((e) => ({
      role: e.role as 'user' | 'assistant',
      content: e.content,
    })),
    currentUserUtterance: params.currentUserUtterance,
  };
}

/**
 * Apply the cacheBreakpoint from buildPrompt to produce the Anthropic SDK
 * system-block array with `cache_control: ephemeral` on the Tier 1 boundary.
 */
export function applyCacheBreakpoint(built: BuiltPrompt): ClaudeSystemBlock[] {
  const tier1 = built.system.slice(0, built.cacheBreakpoint);
  const tier2 = built.system.slice(built.cacheBreakpoint);

  const blocks: ClaudeSystemBlock[] = [
    { type: 'text', text: tier1, cache_control: { type: 'ephemeral' } },
  ];
  if (tier2.length > 0) {
    blocks.push({ type: 'text', text: tier2 });
  }
  return blocks;
}

/** Count open questions (coverage entries still `not_started`). */
function countOpenQuestions(
  coverage: Record<string, CoverageEntry>,
  questions: SessionQuestion[],
): number {
  let count = 0;
  for (const q of questions) {
    const entry = coverage[q.questionId];
    if (!entry || entry.status === 'not_started') {
      count++;
    }
  }
  return count;
}

/**
 * Shape of a synthesized fallback decision. `decisionType: 'fallback'` is
 * produced only by the orchestrator; the parser's StateUpdate excludes it
 * (the LLM never emits it).
 */
interface FallbackDecision {
  decisionType: 'fallback';
  sourceQuestionId: string | null;
  targetQuestionId: string | null;
  reasoning: string;
  coverageUpdates: [];
  flaggedItems: [];
}

/**
 * Synthesized fallback decision per ADR 009 after three consecutive parse
 * failures.
 */
function synthesizeFallbackDecision(): FallbackDecision {
  return {
    decisionType: 'fallback',
    sourceQuestionId: null,
    targetQuestionId: null,
    reasoning: 'Synthesized after three consecutive parse failures',
    coverageUpdates: [],
    flaggedItems: [],
  };
}

// ---------------------------------------------------------------------------
// submitResponse — top-level entry point with version dispatch
// ---------------------------------------------------------------------------

export async function submitResponse(
  prisma: PrismaClient,
  userId: string,
  input: SubmitResponseInput,
  deps: {
    claude: ClaudeApiClient;
    streamingClaude?: ClaudeStreamingClient;
  },
): Promise<SubmitResponseResult> {
  const { interviewId, inputMode } = input;

  // 1. Validate inputMode
  if (!VALID_INPUT_MODES.has(inputMode)) {
    throw validationError('Invalid input mode', {
      inputMode,
      allowedModes: 'voice, text, edited',
    });
  }

  // 2. Verify interview exists, owned by user, and in progress
  const interview = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!interview) throw notFound('Interview not found', { interviewId });
  if (interview.userId !== userId) {
    throw forbidden('Not authorized to submit response for this interview', { interviewId });
  }
  if (interview.status !== 'in_progress') {
    throw invalidState('Interview is not in progress', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 3. Get Redis session
  const session = await getSession(interviewId);
  if (!session) throw invalidState('No active session found for interview', { interviewId });

  // 4. Check turn lock — reject if LLM is currently streaming
  if (session.isStreaming) {
    throw invalidState('LLM is currently streaming; submission not allowed', { interviewId });
  }

  // 5. Dispatch on sessionVersion
  if (getSessionVersion(session) === 'v1-pool') {
    const result = await legacySubmitResponse(prisma, session, input, deps.claude);
    return { responseId: result.responseId, interviewStatus: interview.status };
  }

  // v2-coverage path
  if (!deps.streamingClaude) {
    throw invalidState(
      'streamingClaude dependency is required for v2-coverage sessions',
      { interviewId },
    );
  }
  return submitResponseV2Coverage(
    prisma,
    session,
    input,
    deps.streamingClaude,
  );
}

// ---------------------------------------------------------------------------
// legacySubmitResponse (v1-pool) — unchanged orchestration logic.
// Retained verbatim so in-flight sessions drain naturally via the 4h TTL.
// ---------------------------------------------------------------------------

async function legacySubmitResponse(
  prisma: PrismaClient,
  session: InterviewSession,
  input: SubmitResponseInput,
  claude: ClaudeApiClient,
): Promise<{ responseId: string }> {
  const { interviewId, rawTranscription, inputMode } = input;

  // 5. Find the question the LLM last asked (the one being answered)
  const currentQuestion = getLastAskedQuestion(session);
  if (!currentQuestion) {
    throw invalidState('No active question found in session history', { interviewId });
  }

  // 6. Fetch template context for system prompt and question map
  const { template, templateQuestions } = await fetchTemplateContext(prisma, session.templateId);
  const questionMap = buildQuestionMap(templateQuestions);
  const tqRow = templateQuestions.find((tq) => tq.questionId === currentQuestion.questionId);

  // 7. Snapshot question tags at interview time
  const tagsAtTime = (tqRow?.question.questionTags ?? []).map((qt) => ({
    id: qt.tag.id,
    label: qt.tag.label,
  }));

  // 8. Create InterviewResponse record
  const audioUploadStatus = inputMode === 'text' ? 'not_applicable' : 'pending';
  const response = await prisma.interviewResponse.create({
    data: {
      interviewId,
      questionId: currentQuestion.questionId,
      questionTextAsAsked: session.currentTurnLlmText ?? '',
      sequenceNumber: session.questionsCompleted + 1,
      categoryBucket: tqRow?.categoryBucket ?? null,
      isSkipped: false,
      inputMode,
      rawTranscription,
      audioUploadStatus,
      tagsAtTime,
      processingStatus: 'pending',
    },
  });

  // 9. Compute state patch from response submission and advance history
  const responseSubmittedPatch = applyResponseSubmitted(session);
  const sessionAfterResponse: InterviewSession = { ...session, ...responseSubmittedPatch };

  const historyInputMode: 'voice' | 'text' = inputMode === 'voice' ? 'voice' : 'text';
  const historyWithUserMsg: ConversationEntry[] = [
    ...session.conversationHistory,
    { role: 'user', content: rawTranscription, inputMode: historyInputMode },
  ];

  // 10. Build LLM context (before acquiring lock)
  const promptData = buildPromptData(template, templateQuestions);
  const systemPrompt = buildSystemPrompt(promptData);
  const turnContext = formatTurnContext(
    buildTurnContext(sessionAfterResponse, questionMap, currentQuestion.questionId),
  );
  const llmUserContent = `${rawTranscription}\n\n---\n\n${turnContext}`;
  const llmMessages = buildLlmMessages(session.conversationHistory, llmUserContent);

  // 11. Persist response state + user message + acquire turn lock in one write
  await updateSession(interviewId, {
    ...responseSubmittedPatch,
    conversationHistory: historyWithUserMsg,
    isStreaming: true,
    currentTurnLlmText: '',
  });

  // 12. Call Claude (collect full response in memory)
  let llmResult: ClaudeChatResult;
  try {
    llmResult = await claude.chat({ system: systemPrompt, messages: llmMessages });
  } catch (err) {
    // Error recovery: release lock and clear LLM text
    await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
    throw err;
  }

  // 13. Determine the next question the LLM will ask and apply state updates
  const nextQuestionId = getNextQuestion(sessionAfterResponse);
  const nextQuestionRef = nextQuestionId ? questionMap.get(nextQuestionId) : null;

  const assistantEntry: ConversationEntry = {
    role: 'assistant',
    content: llmResult.content,
    ...(nextQuestionId
      ? {
          questionId: nextQuestionId,
          sequenceNumber: sessionAfterResponse.questionsCompleted + 1,
        }
      : {}),
  };

  const questionAskedPatch =
    nextQuestionId && nextQuestionRef
      ? applyQuestionAsked(sessionAfterResponse, nextQuestionId, nextQuestionRef.categoryBucket)
      : {};

  // 14. Release lock, store LLM output, update history and question state
  await updateSession(interviewId, {
    isStreaming: false,
    currentTurnLlmText: llmResult.content,
    conversationHistory: [...historyWithUserMsg, assistantEntry],
    ...questionAskedPatch,
  });

  // 15. Update response with LLM metrics and increment interview cost totals
  await prisma.$transaction([
    prisma.interviewResponse.update({
      where: { id: response.id },
      data: {
        llmPromptTokens: llmResult.promptTokens,
        llmCompletionTokens: llmResult.completionTokens,
        llmModel: llmResult.model,
        llmLatencyMs: llmResult.latencyMs,
      },
    }),
    prisma.interview.update({
      where: { id: interviewId },
      data: {
        totalLlmPromptTokens: { increment: llmResult.promptTokens },
        totalLlmCompletionTokens: { increment: llmResult.completionTokens },
      },
    }),
  ]);

  return { responseId: response.id };
}

// ---------------------------------------------------------------------------
// submitResponseV2Coverage — ADR 008 / 009 / 010 / 011 / 014 orchestration.
//
// See conversation-protocol-spec-v4.md §4 for the authoritative step list.
// This function runs INSIDE the turn lock; the lock was already asserted
// (and will be acquired below when we set isStreaming=true on the Redis
// session prior to the LLM call).
// ---------------------------------------------------------------------------

async function submitResponseV2Coverage(
  prisma: PrismaClient,
  session: InterviewSession,
  input: SubmitResponseInput,
  streamingClaude: ClaudeStreamingClient,
): Promise<SubmitResponseResult> {
  const { interviewId, rawTranscription, inputMode } = input;

  // ── Identify the pre-turn current-question pointer (fallback for sourceQuestionId) ──
  const preTurnQuestion = getLastAskedQuestion(session);

  // ── Fetch template context ──
  const { template, templateQuestions } =
    await fetchTemplateContext(prisma, session.templateId);
  const knownQuestionIds = new Set(templateQuestions.map((tq) => tq.questionId));
  const sessionQuestions = buildSessionQuestions(templateQuestions);

  const turnNumber = session.questionsCompleted + 1;

  // ── Load the user record for interviewee name (first-name only) ──
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true },
  });
  const intervieweeName = (user?.name ?? '').split(/\s+/)[0] || '';

  // ── Build the v2 session state the prompt builder expects ──
  const sessionStateForPrompt = buildSessionStateForPrompt({
    session,
    templateName: template.name,
    templateDescription: template.description,
    templateSystemPrompt: template.systemPrompt,
    sessionQuestions,
    currentUserUtterance: rawTranscription,
    intervieweeName,
  });

  // ── Assemble Tier 1 + Tier 2 prompt (ADR 010) ──
  const built = buildPrompt(sessionStateForPrompt, PROMPT_VERSION);
  const systemBlocks = applyCacheBreakpoint(built);

  // ── Persist user message + acquire turn lock ──
  const historyInputMode: 'voice' | 'text' = inputMode === 'voice' ? 'voice' : 'text';
  const historyWithUserMsg: ConversationEntry[] = [
    ...session.conversationHistory,
    { role: 'user', content: rawTranscription, inputMode: historyInputMode },
  ];
  await updateSession(interviewId, {
    conversationHistory: historyWithUserMsg,
    isStreaming: true,
    currentTurnLlmText: '',
  });

  // ── Stream the LLM call ──
  let streamResult: ClaudeStreamingResult;
  try {
    streamResult = await streamingClaude.stream({
      system: systemBlocks,
      messages: built.messages.map((m: AnthropicMessage) => ({
        role: m.role,
        content: m.content,
      })),
      // Pass-through token sink. SSE wiring hooks here in a later milestone;
      // today the canonical conversational text is read from
      // `streamResult.preDelimiterContent` after streaming completes. The
      // callback is still supplied so the DelimiterBoundaryDetector actually
      // runs end-to-end in the underlying client (observable via tests).
      onPreDelimiterToken: (_token: string) => {
        // intentionally no-op
      },
    });
  } catch (err) {
    await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
    throw err;
  }

  // ── Parse the state-update block ──
  const parseResult = parseStateUpdate(streamResult.fullContent, knownQuestionIds);

  // Work over a local v2-aware session (coverage/threads/etc defaults) for
  // coverage-map and parse-failure counter updates.
  let workingSession = {
    ...session,
    conversationHistory: historyWithUserMsg,
    coverage: session.coverage ?? {},
    activeThreads: session.activeThreads ?? [],
    factsLedger: session.factsLedger ?? [],
    rapportNotes: session.rapportNotes ?? [],
    consecutiveParseFailures: session.consecutiveParseFailures ?? 0,
  } satisfies InterviewSession;

  // Conversational portion actually delivered to the interviewee.
  const conversationalText =
    parseResult.ok === false
      ? parseResult.conversational
      : streamResult.preDelimiterContent.length > 0
      ? streamResult.preDelimiterContent
      : parseResult.conversational;

  // ── Compute decision + coverage transitions + flagged items ──
  let decision: {
    decisionType: OrchestrationDecisionType;
    sourceQuestionId: string | null;
    targetQuestionId: string | null;
    reasoning: string;
  };

  let transitions: CoverageTransition[] = [];
  let persistedFlaggedItems: PersistedFlaggedItem[] = [];
  let closeInterviewSuccessfully = false;

  if (parseResult.ok === false) {
    // Hard parse failure — increment counter, emit state_parse_failures, no coverage apply.
    workingSession = incrementParseFailures(workingSession);

    emitStateParseFailure({
      interviewId,
      turnNumber,
      parseErrorType: parseResult.errorType,
      model: streamResult.model,
      promptTokens: streamResult.promptTokens,
      completionTokens: streamResult.completionTokens,
      partialApplied: false,
    });

    if (
      (workingSession.consecutiveParseFailures ?? 0) >= MAX_CONSECUTIVE_PARSE_FAILURES
    ) {
      // Synthesize fallback decision per ADR 009
      const fallback = synthesizeFallbackDecision();
      decision = {
        decisionType: fallback.decisionType,
        sourceQuestionId: fallback.sourceQuestionId,
        targetQuestionId: fallback.targetQuestionId,
        reasoning: fallback.reasoning,
      };

      // Optionally: if required questions already satisfied, close the interview.
      const completionTemplate: EvaluateCompletionTemplate = {
        questions: sessionQuestions.map((q) => ({
          questionId: q.questionId,
          isRequired: q.isRequired,
        })),
      };
      const { isComplete } = evaluateCompletion(workingSession, completionTemplate);
      if (isComplete) {
        closeInterviewSuccessfully = true;
      }
    } else {
      // Ongoing parse failure, but below fallback threshold — emit a
      // placeholder "fallback" decision so observability still has a row,
      // with no coverage changes. The prompt will retry parsing next turn.
      decision = {
        decisionType: 'fallback' as const,
        sourceQuestionId: preTurnQuestion?.questionId ?? null,
        targetQuestionId: null,
        reasoning: `Parse failure: ${parseResult.errorType}`,
      };
    }
  } else {
    // ok: true | 'partial' — apply state update.
    const stateUpdate: StateUpdate = parseResult.stateUpdate;

    if (parseResult.ok === 'partial') {
      emitStateParseFailure({
        interviewId,
        turnNumber,
        parseErrorType: parseResult.errorType,
        model: streamResult.model,
        promptTokens: streamResult.promptTokens,
        completionTokens: streamResult.completionTokens,
        unknownQuestionIdCount: parseResult.unknownQuestionIdCount,
        partialApplied: true,
      });
    }

    // Reset parse failures on any successful parse (full or partial).
    workingSession = resetParseFailures(workingSession);

    // Apply coverage updates
    const { newCoverage, transitions: t } = applyCoverageUpdates(
      workingSession,
      stateUpdate.coverageUpdates,
      turnNumber,
    );
    workingSession = { ...workingSession, coverage: newCoverage };
    transitions = t;

    // Apply flagged items
    persistedFlaggedItems = await applyFlaggedItems(
      prisma,
      interviewId,
      turnNumber,
      stateUpdate.flaggedItems,
    );

    // Evaluate completion when LLM declared close_interview
    if (stateUpdate.decisionType === 'close_interview') {
      const completionTemplate: EvaluateCompletionTemplate = {
        questions: sessionQuestions.map((q) => ({
          questionId: q.questionId,
          isRequired: q.isRequired,
        })),
      };
      const completion = evaluateCompletion(workingSession, completionTemplate);

      if (completion.isComplete) {
        closeInterviewSuccessfully = true;
        decision = {
          decisionType: 'close_interview',
          sourceQuestionId: stateUpdate.sourceQuestionId,
          targetQuestionId: stateUpdate.targetQuestionId,
          reasoning: stateUpdate.reasoning,
        };
      } else {
        // Demote to fallback per conversation-protocol-spec-v4 §4.
        decision = {
          decisionType: 'fallback',
          sourceQuestionId: stateUpdate.sourceQuestionId,
          targetQuestionId: stateUpdate.targetQuestionId,
          reasoning: `Demoted close_interview: ${completion.gapReasons.join('; ')}`,
        };
      }
    } else {
      decision = {
        decisionType: stateUpdate.decisionType,
        sourceQuestionId: stateUpdate.sourceQuestionId,
        targetQuestionId: stateUpdate.targetQuestionId,
        reasoning: stateUpdate.reasoning,
      };
    }
  }

  // ── Determine the questionId the response row will record ──
  const responseQuestionId =
    decision.sourceQuestionId ?? preTurnQuestion?.questionId ?? null;
  if (!responseQuestionId) {
    // Should not happen except on the very first user message in an interview
    // that somehow had no opening assistant message. Fail fast.
    await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
    throw invalidState('Cannot determine question for response row', { interviewId });
  }

  const tqForResponse = templateQuestions.find(
    (tq) => tq.questionId === responseQuestionId,
  );
  const tagsAtTimeForRow = (tqForResponse?.question.questionTags ?? []).map((qt) => ({
    id: qt.tag.id,
    label: qt.tag.label,
  }));

  // ── Persist response row + enrichment outbox row in a single transaction ──
  const audioUploadStatus = inputMode === 'text' ? 'not_applicable' : 'pending';

  const [response] = await prisma.$transaction(async (tx) => {
    const row = await tx.interviewResponse.create({
      data: {
        interviewId,
        questionId: responseQuestionId,
        questionTextAsAsked: conversationalText,
        sequenceNumber: turnNumber,
        categoryBucket: tqForResponse?.categoryBucket ?? null,
        isSkipped: false,
        inputMode,
        rawTranscription,
        audioUploadStatus,
        tagsAtTime: tagsAtTimeForRow,
        processingStatus: 'pending',
        llmPromptTokens: streamResult.promptTokens,
        llmCompletionTokens: streamResult.completionTokens,
        llmModel: streamResult.model,
        llmLatencyMs: streamResult.latencyMs,
      },
    });

    await tx.enrichmentOutbox.create({
      data: {
        responseId: row.id,
        interviewId,
      },
    });

    await tx.interview.update({
      where: { id: interviewId },
      data: {
        totalLlmPromptTokens: { increment: streamResult.promptTokens },
        totalLlmCompletionTokens: { increment: streamResult.completionTokens },
      },
    });

    return [row];
  });

  // ── Build the assistant entry for conversation history ──
  const assistantEntry: ConversationEntry = {
    role: 'assistant',
    content: conversationalText,
    ...(decision.targetQuestionId
      ? {
          questionId: decision.targetQuestionId,
          sequenceNumber: turnNumber + 1,
        }
      : {}),
  };

  // ── Advance questionsCompleted + write coverage/threads/parse-failure back to Redis ──
  await updateSession(interviewId, {
    isStreaming: false,
    currentTurnLlmText: conversationalText,
    conversationHistory: [...historyWithUserMsg, assistantEntry],
    questionsCompleted: session.questionsCompleted + 1,
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
    coverage: workingSession.coverage,
    consecutiveParseFailures: workingSession.consecutiveParseFailures ?? 0,
  });

  // ── Mark interview complete if close_interview validated ──
  let interviewStatus = 'in_progress';
  if (closeInterviewSuccessfully) {
    const now = new Date();
    await prisma.interview.update({
      where: { id: interviewId },
      data: { status: 'completed', completedAt: now },
    });
    interviewStatus = 'completed';
  }

  // ── Emit coverage_transitions (one per transition) ──
  for (const tr of transitions) {
    emitCoverageTransition({
      interviewId,
      questionId: tr.questionId,
      templateId: session.templateId,
      oldStatus: tr.oldStatus,
      newStatus: tr.newStatus,
      oldConfidence: tr.oldConfidence,
      newConfidence: tr.newConfidence,
      turnNumber,
      hasSummary: tr.summary.length > 0,
      summaryLength: tr.summary.length,
    });
  }

  // ── Emit flagged_items (one per persisted item) ──
  for (const item of persistedFlaggedItems) {
    emitFlaggedItem({
      flaggedItemId: item.id,
      interviewId,
      templateId: session.templateId,
      sourceTurn: item.sourceTurn,
      priority: item.priority,
      suggestedTagCount: item.suggestedTags.length,
      descriptionLength: item.description.length,
    });
  }

  // ── Emit orchestration_decisions ──
  const openQuestionCount = countOpenQuestions(
    workingSession.coverage,
    sessionQuestions,
  );
  const activeThreadCount = (workingSession.activeThreads ?? []).length;

  emitOrchestrationDecision({
    interviewId,
    templateId: session.templateId,
    turnNumber,
    decisionType: decision.decisionType,
    sourceQuestionId: decision.sourceQuestionId ?? '',
    targetQuestionId: decision.targetQuestionId ?? '',
    openQuestionCount,
    activeThreadCount,
    promptTokens: streamResult.promptTokens,
    completionTokens: streamResult.completionTokens,
    latencyMs: streamResult.latencyMs,
    model: streamResult.model,
  });

  // Telemetry: the existing llm_turns event (from sse/stream.ts) does not
  // fire here because we do not route through streamLlmToSSE for v2. The
  // orchestration_decisions event carries the same cost/latency/model
  // attributes; ADR 014 documents the correlation on (interviewId,turnNumber).

  return { responseId: response.id, interviewStatus };
}

// ---------------------------------------------------------------------------
// skipQuestion
// ---------------------------------------------------------------------------

export async function skipQuestion(
  prisma: PrismaClient,
  userId: string,
  interviewId: string,
  deps: { claude: ClaudeApiClient },
): Promise<SkipQuestionResult> {
  // 1. Verify interview
  const interview = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!interview) throw notFound('Interview not found', { interviewId });
  if (interview.userId !== userId) {
    throw forbidden('Not authorized to skip question for this interview', { interviewId });
  }
  if (interview.status !== 'in_progress') {
    throw invalidState('Interview is not in progress', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 2. Get Redis session
  const session = await getSession(interviewId);
  if (!session) throw invalidState('No active session found for interview', { interviewId });

  // 3. Check turn lock
  if (session.isStreaming) {
    throw invalidState('LLM is currently streaming; skip not allowed', { interviewId });
  }

  // 4. Find the current question to skip
  const currentQuestion = getLastAskedQuestion(session);
  if (!currentQuestion) {
    throw invalidState('No active question found in session history', { interviewId });
  }

  // 5. v2-coverage skip path: mark coverage entry as skipped, emit transition,
  // do NOT call the LLM. This is a user-intent skip, distinct from LLM
  // decisionType: 'move_on' with status: 'skipped'.
  if (getSessionVersion(session) === 'v2-coverage') {
    const turnNumber = session.questionsCompleted + 1;
    const priorEntry = (session.coverage ?? {})[currentQuestion.questionId];
    const oldStatus = priorEntry?.status ?? 'not_started';
    const oldConfidence = priorEntry?.confidence ?? null;

    // Persist skipped response row (no LLM call)
    const { templateQuestions } = await fetchTemplateContext(prisma, session.templateId);
    const tqRow = templateQuestions.find((tq) => tq.questionId === currentQuestion.questionId);

    await prisma.interviewResponse.create({
      data: {
        interviewId,
        questionId: currentQuestion.questionId,
        questionTextAsAsked: session.currentTurnLlmText ?? '',
        sequenceNumber: turnNumber,
        categoryBucket: tqRow?.categoryBucket ?? null,
        isSkipped: true,
        inputMode: 'text',
        rawTranscription: null,
        audioUploadStatus: 'not_applicable',
        tagsAtTime: [],
        processingStatus: 'pending',
      },
    });

    const workingSession = markQuestionSkipped(
      {
        coverage: session.coverage ?? {},
        activeThreads: session.activeThreads ?? [],
        factsLedger: session.factsLedger ?? [],
        rapportNotes: session.rapportNotes ?? [],
        consecutiveParseFailures: session.consecutiveParseFailures ?? 0,
        sessionVersion: 'v2-coverage',
      },
      currentQuestion.questionId,
      turnNumber,
    );

    await updateSession(interviewId, {
      coverage: workingSession.coverage,
      questionsCompleted: session.questionsCompleted + 1,
      lastActivityAt: new Date().toISOString(),
      idleWarningShown: false,
    });

    // Emit a single coverage_transitions event for the user-intent skip.
    emitCoverageTransition({
      interviewId,
      questionId: currentQuestion.questionId,
      templateId: session.templateId,
      oldStatus,
      newStatus: 'skipped',
      oldConfidence,
      // newConfidence is CoverageConfidence (non-null). For a skipped entry
      // there is no confidence claim; pick 'low' as the neutral telemetry
      // signal — ADR 014 documents confidence attributes as claim-metadata,
      // not a quality judgment for skipped items.
      newConfidence: 'low',
      turnNumber,
      hasSummary: false,
      summaryLength: 0,
    });

    return { success: true };
  }

  // Legacy v1-pool skip path below — unchanged.

  // 5. Fetch template context
  const { template, templateQuestions } = await fetchTemplateContext(prisma, session.templateId);
  const questionMap = buildQuestionMap(templateQuestions);
  const tqRow = templateQuestions.find((tq) => tq.questionId === currentQuestion.questionId);

  // 6. Create skipped InterviewResponse record
  const skippedResponse = await prisma.interviewResponse.create({
    data: {
      interviewId,
      questionId: currentQuestion.questionId,
      questionTextAsAsked: session.currentTurnLlmText ?? '',
      sequenceNumber: session.questionsCompleted + 1,
      categoryBucket: tqRow?.categoryBucket ?? null,
      isSkipped: true,
      inputMode: 'text',
      rawTranscription: null,
      audioUploadStatus: 'not_applicable',
      tagsAtTime: [],
      processingStatus: 'pending',
    },
  });

  // 7. Apply skipped state patch
  const skippedPatch = applyQuestionSkipped(
    session,
    currentQuestion.questionId,
    tqRow?.categoryBucket ?? '',
  );
  const sessionAfterSkip: InterviewSession = { ...session, ...skippedPatch };

  // 8. Build LLM context
  const promptData = buildPromptData(template, templateQuestions);
  const systemPrompt = buildSystemPrompt(promptData);
  const turnContext = formatTurnContext(
    buildTurnContext(sessionAfterSkip, questionMap, currentQuestion.questionId),
  );
  const skipUserContent = `[Question skipped]\n\n---\n\n${turnContext}`;
  const llmMessages = buildLlmMessages(session.conversationHistory, skipUserContent);

  // 9. Persist skip state + acquire turn lock
  const skipHistoryEntry: ConversationEntry = {
    role: 'user',
    content: '[Question skipped]',
    inputMode: 'text',
  };
  await updateSession(interviewId, {
    ...skippedPatch,
    conversationHistory: [...session.conversationHistory, skipHistoryEntry],
    isStreaming: true,
    currentTurnLlmText: '',
  });

  // 10. Call Claude for the next question
  let llmResult: ClaudeChatResult;
  try {
    llmResult = await deps.claude.chat({ system: systemPrompt, messages: llmMessages });
  } catch (err) {
    await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
    throw err;
  }

  // 11. Determine next question and update session
  const nextQuestionId = getNextQuestion(sessionAfterSkip);
  const nextQuestionRef = nextQuestionId ? questionMap.get(nextQuestionId) : null;

  const assistantEntry: ConversationEntry = {
    role: 'assistant',
    content: llmResult.content,
    ...(nextQuestionId
      ? {
          questionId: nextQuestionId,
          sequenceNumber: sessionAfterSkip.questionsCompleted + 1,
        }
      : {}),
  };

  const questionAskedPatch =
    nextQuestionId && nextQuestionRef
      ? applyQuestionAsked(sessionAfterSkip, nextQuestionId, nextQuestionRef.categoryBucket)
      : {};

  const historyWithSkip = [...session.conversationHistory, skipHistoryEntry];
  await updateSession(interviewId, {
    isStreaming: false,
    currentTurnLlmText: llmResult.content,
    conversationHistory: [...historyWithSkip, assistantEntry],
    ...questionAskedPatch,
  });

  // 12. Update skipped response with LLM metrics and interview cost totals
  await prisma.$transaction([
    prisma.interviewResponse.update({
      where: { id: skippedResponse.id },
      data: {
        llmPromptTokens: llmResult.promptTokens,
        llmCompletionTokens: llmResult.completionTokens,
        llmModel: llmResult.model,
        llmLatencyMs: llmResult.latencyMs,
      },
    }),
    prisma.interview.update({
      where: { id: interviewId },
      data: {
        totalLlmPromptTokens: { increment: llmResult.promptTokens },
        totalLlmCompletionTokens: { increment: llmResult.completionTokens },
      },
    }),
  ]);

  return { success: true };
}

// ---------------------------------------------------------------------------
// completeInterview
// ---------------------------------------------------------------------------

export async function completeInterview(
  prisma: PrismaClient,
  userId: string,
  interviewId: string,
  deps: { events: EventPublisher },
): Promise<unknown> {
  // 1. Verify interview
  const interview = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!interview) throw notFound('Interview not found', { interviewId });
  if (interview.userId !== userId) {
    throw forbidden('Not authorized to complete this interview', { interviewId });
  }
  if (interview.status !== 'in_progress') {
    throw invalidState('Interview is not in progress', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 2. Get final session state
  const session = await getSession(interviewId);

  // 3. Check turn lock — cannot complete while LLM is streaming
  if (session?.isStreaming) {
    throw invalidState('LLM is currently streaming; cannot complete interview now', {
      interviewId,
    });
  }

  const now = new Date();

  // 4. Persist completed status, final snapshot, and mark assignment complete
  const [updatedInterview] = await prisma.$transaction([
    prisma.interview.update({
      where: { id: interviewId },
      data: {
        status: 'completed',
        completedAt: now,
        sessionSnapshot: session
          ? (session as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    }),
    prisma.userTemplate.updateMany({
      where: { userId, templateId: interview.templateId, status: 'active' },
      data: { status: 'completed', completedAt: now },
    }),
  ]);

  // 5. Flush Redis session
  await deleteSession(interviewId);

  // 6. Publish EventBridge event to trigger cleaning pipeline
  await deps.events.publish({
    detailType: 'InterviewCompleted',
    detail: {
      interviewId,
      userId,
      templateId: interview.templateId,
    },
  });

  clickHouseWrite('interview_lifecycle', {
    interviewId,
    templateId: interview.templateId,
    event: 'completed',
    totalLlmPromptTokens: interview.totalLlmPromptTokens,
    totalLlmCompletionTokens: interview.totalLlmCompletionTokens,
    totalTtsCharacters: interview.totalTtsCharacters,
  });

  return updatedInterview;
}
