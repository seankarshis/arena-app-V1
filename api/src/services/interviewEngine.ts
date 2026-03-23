// ---------------------------------------------------------------------------
// Arena Interview Engine — submitResponse, skipQuestion, completeInterview
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
  type TemplateQuestionRef,
  type FollowupTrigger,
} from './stateManager';
import {
  buildSystemPrompt,
  type PromptTemplateData,
  type PromptQuestion,
} from './promptConstructor';
import {
  notFound,
  invalidState,
  forbidden,
  validationError,
} from '../middleware/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LLM_MODEL = 'claude-sonnet-4-20250514';
const MAX_LLM_TOKENS = 4096;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? 'arena-event-bus';

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
}

export interface SkipQuestionResult {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Allowed input modes
// ---------------------------------------------------------------------------

const VALID_INPUT_MODES = new Set(['voice', 'text', 'edited']);

// ---------------------------------------------------------------------------
// Factory: Claude API client (production)
// ---------------------------------------------------------------------------

export function createClaudeApiClient(apiKey: string): ClaudeApiClient {
  return {
    async chat({
      system,
      messages,
      model = DEFAULT_LLM_MODEL,
      maxTokens = MAX_LLM_TOKENS,
    }) {
      // @ts-expect-error — package installed at deploy time, not in devDependencies
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
      const textBlock = response.content.find(
        (b: { type: string }) => b.type === 'text',
      );

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
// Factory: EventBridge publisher (production)
// ---------------------------------------------------------------------------

export function createEventPublisher(): EventPublisher {
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
// Internal: DB row types
// ---------------------------------------------------------------------------

interface TemplateQuestionRow {
  id: string;
  questionId: string;
  categoryBucket: string;
  isRequired: boolean;
  sequenceOrder: number;
  followupTriggers: unknown;
  question: {
    text: string;
    questionTags: Array<{
      tag: { id: string; label: string; tagType: string };
    }>;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
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
  template: { id: string; name: string; description: string | null };
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

  return { template, templateQuestions };
}

/** Convert DB rows into the PromptTemplateData shape for buildSystemPrompt. */
function buildPromptData(
  template: { name: string; description: string | null },
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
  return { name: template.name, description: template.description, questions };
}

/** Returns the first question still remaining in the session (required first, then optional). */
function getNextQuestion(session: InterviewSession): string | null {
  return session.requiredRemaining[0] ?? session.optionalRemaining[0] ?? null;
}

// ---------------------------------------------------------------------------
// submitResponse
// ---------------------------------------------------------------------------

export async function submitResponse(
  prisma: PrismaClient,
  userId: string,
  input: SubmitResponseInput,
  deps: { claude: ClaudeApiClient },
): Promise<SubmitResponseResult> {
  const { interviewId, rawTranscription, inputMode } = input;

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
    tagType: qt.tag.tagType,
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
    llmResult = await deps.claude.chat({ system: systemPrompt, messages: llmMessages });
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

  return updatedInterview;
}
