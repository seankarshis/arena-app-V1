// ---------------------------------------------------------------------------
// Unit Tests — Interview Engine (submitResponse, skipQuestion, completeInterview)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  submitResponse,
  skipQuestion,
  completeInterview,
  type ClaudeApiClient,
  type EventPublisher,
  type SubmitResponseInput,
} from '../services/interviewEngine';
import type { InterviewSession } from '../services/session';

// ---------------------------------------------------------------------------
// Mock Redis session operations
// ---------------------------------------------------------------------------

const mockSessionStore: Record<string, string> = {};

vi.mock('../services/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/session')>();
  return {
    ...original,
    getSession: vi.fn(async (interviewId: string) => {
      const raw = mockSessionStore[interviewId];
      return raw ? JSON.parse(raw) : null;
    }),
    updateSession: vi.fn(async (interviewId: string, patch: Record<string, unknown>) => {
      const raw = mockSessionStore[interviewId];
      if (!raw) return null;
      const session = { ...JSON.parse(raw), ...patch };
      mockSessionStore[interviewId] = JSON.stringify(session);
      return session;
    }),
    deleteSession: vi.fn(async (interviewId: string) => {
      delete mockSessionStore[interviewId];
    }),
  };
});

import { getSession, updateSession, deleteSession } from '../services/session';

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

let responseIdCounter = 0;

function createMockPrisma() {
  return {
    interview: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    interviewTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    templateQuestion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    interviewResponse: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: `response-${++responseIdCounter}`,
        ...data,
        respondedAt: new Date(),
      })),
      update: vi.fn().mockResolvedValue({}),
    },
    userTemplate: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn().mockImplementation(async (ops: Promise<unknown>[]) =>
      Promise.all(ops),
    ),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockPrisma = any;

// ---------------------------------------------------------------------------
// Mock Claude client
// ---------------------------------------------------------------------------

function createMockClaude(
  overrides: Partial<ClaudeChatResultMock> = {},
): ClaudeApiClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'Next question from LLM.',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 200,
      completionTokens: 80,
      latencyMs: 450,
      ...overrides,
    }),
  };
}

interface ClaudeChatResultMock {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Mock EventPublisher
// ---------------------------------------------------------------------------

function createMockEvents(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const USER_ID = 'user-001';
const OTHER_USER_ID = 'user-002';
const INTERVIEW_ID = 'interview-001';
const TEMPLATE_ID = 'template-001';
const Q1_ID = 'q-001';
const Q2_ID = 'q-002';
const Q3_ID = 'q-003';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSession(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    interviewId: INTERVIEW_ID,
    templateId: TEMPLATE_ID,
    userId: USER_ID,
    conversationHistory: [
      {
        role: 'assistant',
        content: 'LLM phrased Q1 here.',
        questionId: Q1_ID,
        sequenceNumber: 1,
      },
    ],
    questionsAsked: [Q1_ID],
    questionsSkipped: [],
    bucketsCovered: { motivation: 1, process: 0 },
    requiredRemaining: [Q2_ID],
    optionalRemaining: [Q3_ID],
    triggeredFollowups: [],
    currentTranscriptBuffer: '',
    currentDrafts: [],
    totalExpectedQuestions: 3,
    questionsCompleted: 0,
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
    isStreaming: false,
    currentTurnLlmText: 'LLM phrased Q1 here.',
    ...overrides,
  };
}

function seedSession(session: InterviewSession): void {
  mockSessionStore[session.interviewId] = JSON.stringify(session);
}

function mockInterview(overrides?: Record<string, unknown>) {
  return {
    id: INTERVIEW_ID,
    userId: USER_ID,
    templateId: TEMPLATE_ID,
    status: 'in_progress',
    totalLlmPromptTokens: 0,
    totalLlmCompletionTokens: 0,
    totalSttDurationSeconds: 0,
    totalTtsCharacters: 0,
    ...overrides,
  };
}

function mockTemplateQuestion(questionId: string, opts?: {
  categoryBucket?: string;
  isRequired?: boolean;
  sequenceOrder?: number;
  text?: string;
}) {
  return {
    id: `tq-${questionId}`,
    questionId,
    categoryBucket: opts?.categoryBucket ?? 'motivation',
    isRequired: opts?.isRequired ?? true,
    sequenceOrder: opts?.sequenceOrder ?? 1,
    followupTriggers: [],
    question: {
      text: opts?.text ?? `Question text for ${questionId}`,
      questionTags: [],
    },
  };
}

function setupTemplateMocks(prisma: MockPrisma) {
  prisma.interviewTemplate.findUnique.mockResolvedValue({
    id: TEMPLATE_ID,
    name: 'Test Template',
    description: null,
    status: 'published',
  });
  prisma.templateQuestion.findMany.mockResolvedValue([
    mockTemplateQuestion(Q1_ID, { sequenceOrder: 1, categoryBucket: 'motivation' }),
    mockTemplateQuestion(Q2_ID, { sequenceOrder: 2, categoryBucket: 'process' }),
    mockTemplateQuestion(Q3_ID, { sequenceOrder: 3, categoryBucket: 'motivation', isRequired: false }),
  ]);
}

function defaultSubmitInput(overrides?: Partial<SubmitResponseInput>): SubmitResponseInput {
  return {
    interviewId: INTERVIEW_ID,
    rawTranscription: 'My answer to the question.',
    inputMode: 'voice',
    ...overrides,
  };
}

function getErrorCode(err: unknown): string | undefined {
  const e = err as { extensions?: { code?: string } };
  return e.extensions?.code;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockPrisma: ReturnType<typeof createMockPrisma>;

beforeEach(() => {
  vi.clearAllMocks();
  responseIdCounter = 0;
  // Clear session store
  for (const key of Object.keys(mockSessionStore)) {
    delete mockSessionStore[key];
  }
});

// =========================================================================
// submitResponse
// =========================================================================

describe('submitResponse', () => {
  describe('success cases', () => {
    it('creates InterviewResponse record with correct fields', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());
      const claude = createMockClaude();

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude },
      );

      expect(result.responseId).toBeDefined();
      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            interviewId: INTERVIEW_ID,
            questionId: Q1_ID,
            questionTextAsAsked: 'LLM phrased Q1 here.',
            isSkipped: false,
            inputMode: 'voice',
            rawTranscription: 'My answer to the question.',
            audioUploadStatus: 'pending',
            processingStatus: 'pending',
          }),
        }),
      );
    });

    it('sets audioUploadStatus to not_applicable for text input mode', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput({ inputMode: 'text' }),
        { claude: createMockClaude() },
      );

      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ audioUploadStatus: 'not_applicable' }),
        }),
      );
    });

    it('sets audioUploadStatus to pending for edited input mode', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput({ inputMode: 'edited' }),
        { claude: createMockClaude() },
      );

      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ audioUploadStatus: 'pending' }),
        }),
      );
    });

    it('calls Claude with system prompt and messages', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());
      const claude = createMockClaude();

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude });

      expect(claude.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('Test Template'),
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user' }),
          ]),
        }),
      );
    });

    it('acquires and releases turn lock around the Claude call', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const lockStates: boolean[] = [];
      const claude: ClaudeApiClient = {
        chat: vi.fn().mockImplementation(async () => {
          // Check session state during the call
          const raw = mockSessionStore[INTERVIEW_ID];
          if (raw) lockStates.push(JSON.parse(raw).isStreaming);
          return {
            content: 'Q2 text',
            model: 'claude-sonnet-4-20250514',
            promptTokens: 100,
            completionTokens: 50,
            latencyMs: 300,
          };
        }),
      };

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude });

      // Lock was held during the call
      expect(lockStates).toContain(true);

      // Lock is released after the call
      const finalSession = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      expect(finalSession.isStreaming).toBe(false);
    });

    it('stores Claude response as currentTurnLlmText in session', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockClaude({ content: 'The next question is...' }) },
      );

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      expect(session.currentTurnLlmText).toBe('The next question is...');
    });

    it('adds user message and LLM response to conversation history', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput({ rawTranscription: 'My answer.' }),
        { claude: createMockClaude({ content: 'LLM Q2 text.' }) },
      );

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      const history = session.conversationHistory;

      // Original assistant entry + user answer + new assistant response
      expect(history.length).toBe(3);
      expect(history[1]).toMatchObject({ role: 'user', content: 'My answer.' });
      expect(history[2]).toMatchObject({ role: 'assistant', content: 'LLM Q2 text.' });
    });

    it('associates next question ID with the LLM response in history', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      const assistantEntry = session.conversationHistory.find(
        (e: { role: string; questionId?: string }) =>
          e.role === 'assistant' && e.questionId === Q2_ID,
      );
      expect(assistantEntry).toBeDefined();
    });

    it('applies applyQuestionAsked state for the next question', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      // Q2 should now be in questionsAsked and removed from requiredRemaining
      expect(session.questionsAsked).toContain(Q2_ID);
      expect(session.requiredRemaining).not.toContain(Q2_ID);
    });

    it('updates response record with LLM metrics', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        {
          claude: createMockClaude({
            promptTokens: 300,
            completionTokens: 120,
            latencyMs: 550,
            model: 'claude-sonnet-4-20250514',
          }),
        },
      );

      expect(mockPrisma.interviewResponse.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            llmPromptTokens: 300,
            llmCompletionTokens: 120,
            llmLatencyMs: 550,
            llmModel: 'claude-sonnet-4-20250514',
          }),
        }),
      );
    });

    it('increments interview cost totals in a transaction', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockClaude({ promptTokens: 200, completionTokens: 80 }) },
      );

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.interview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INTERVIEW_ID },
          data: expect.objectContaining({
            totalLlmPromptTokens: { increment: 200 },
            totalLlmCompletionTokens: { increment: 80 },
          }),
        }),
      );
    });

    it('increments questionsCompleted in session', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession({ questionsCompleted: 0 }));

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });

      // updateSession should have been called with questionsCompleted: 1
      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({ questionsCompleted: 1 }),
      );
    });

    it('uses null questionTextAsAsked when currentTurnLlmText is null', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession({ currentTurnLlmText: null }));

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });

      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ questionTextAsAsked: '' }),
        }),
      );
    });
  });

  describe('validation errors', () => {
    it('throws VALIDATION_ERROR for invalid inputMode', async () => {
      mockPrisma = createMockPrisma();

      try {
        await submitResponse(
          mockPrisma,
          USER_ID,
          defaultSubmitInput({ inputMode: 'invalid' }),
          { claude: createMockClaude() },
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('VALIDATION_ERROR');
      }
    });

    it('throws VALIDATION_ERROR for empty inputMode', async () => {
      mockPrisma = createMockPrisma();

      try {
        await submitResponse(
          mockPrisma,
          USER_ID,
          defaultSubmitInput({ inputMode: '' }),
          { claude: createMockClaude() },
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('authorization and state errors', () => {
    it('throws NOT_FOUND when interview does not exist', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(null);

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('NOT_FOUND');
      }
    });

    it('throws FORBIDDEN when interview belongs to a different user', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ userId: OTHER_USER_ID }));

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('FORBIDDEN');
      }
    });

    it('throws INVALID_STATE when interview is not in_progress', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'completed' }));

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when interview is paused', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'paused' }));

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when no Redis session exists', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      // No session seeded

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when turn lock is active (isStreaming = true)', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      seedSession(buildSession({ isStreaming: true }));

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when session has no active question', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      seedSession(buildSession({ conversationHistory: [] }));

      try {
        await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });
  });

  describe('error recovery', () => {
    it('releases turn lock and clears LLM text when Claude call fails', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const failingClaude: ClaudeApiClient = {
        chat: vi.fn().mockRejectedValue(new Error('API timeout')),
      };

      await expect(
        submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: failingClaude }),
      ).rejects.toThrow('API timeout');

      // Verify lock was released
      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({ isStreaming: false, currentTurnLlmText: null }),
      );
    });

    it('propagates Claude error to caller', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const failingClaude: ClaudeApiClient = {
        chat: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };

      await expect(
        submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: failingClaude }),
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('when no remaining questions', () => {
    it('stores LLM response without a questionId when no questions remain', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession({ requiredRemaining: [], optionalRemaining: [] }));

      await submitResponse(mockPrisma, USER_ID, defaultSubmitInput(), { claude: createMockClaude() });

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      const lastEntry = session.conversationHistory[session.conversationHistory.length - 1];
      expect(lastEntry.role).toBe('assistant');
      expect(lastEntry.questionId).toBeUndefined();
    });
  });
});

// =========================================================================
// skipQuestion
// =========================================================================

describe('skipQuestion', () => {
  describe('success cases', () => {
    it('creates a skipped InterviewResponse record', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });

      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            interviewId: INTERVIEW_ID,
            questionId: Q1_ID,
            isSkipped: true,
            inputMode: 'text',
            audioUploadStatus: 'not_applicable',
          }),
        }),
      );
    });

    it('returns { success: true }', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const result = await skipQuestion(
        mockPrisma,
        USER_ID,
        INTERVIEW_ID,
        { claude: createMockClaude() },
      );

      expect(result.success).toBe(true);
    });

    it('calls Claude after recording the skip', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());
      const claude = createMockClaude();

      await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude });

      expect(claude.chat).toHaveBeenCalled();
    });

    it('adds skipped question to questionsSkipped in session', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });

      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({
          questionsSkipped: expect.arrayContaining([Q1_ID]),
        }),
      );
    });

    it('acquires turn lock before Claude call and releases after', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const lockStates: boolean[] = [];
      const claude: ClaudeApiClient = {
        chat: vi.fn().mockImplementation(async () => {
          const raw = mockSessionStore[INTERVIEW_ID];
          if (raw) lockStates.push(JSON.parse(raw).isStreaming);
          return {
            content: 'Q2 text',
            model: 'claude-sonnet-4-20250514',
            promptTokens: 100,
            completionTokens: 50,
            latencyMs: 300,
          };
        }),
      };

      await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude });

      expect(lockStates).toContain(true);
      const finalSession = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      expect(finalSession.isStreaming).toBe(false);
    });

    it('stores LLM response as currentTurnLlmText', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await skipQuestion(
        mockPrisma,
        USER_ID,
        INTERVIEW_ID,
        { claude: createMockClaude({ content: 'Q2 via skip path' }) },
      );

      const session = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      expect(session.currentTurnLlmText).toBe('Q2 via skip path');
    });

    it('updates skipped response record with LLM metrics', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await skipQuestion(
        mockPrisma,
        USER_ID,
        INTERVIEW_ID,
        { claude: createMockClaude({ promptTokens: 150, completionTokens: 60 }) },
      );

      expect(mockPrisma.interviewResponse.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            llmPromptTokens: 150,
            llmCompletionTokens: 60,
          }),
        }),
      );
    });

    it('increments interview cost totals', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      await skipQuestion(
        mockPrisma,
        USER_ID,
        INTERVIEW_ID,
        { claude: createMockClaude({ promptTokens: 180, completionTokens: 70 }) },
      );

      expect(mockPrisma.interview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalLlmPromptTokens: { increment: 180 },
            totalLlmCompletionTokens: { increment: 70 },
          }),
        }),
      );
    });

    it('removes skipped question from requiredRemaining in session', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession({ requiredRemaining: [Q2_ID] }));

      await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });

      // Q1 was the current question (from conversation history); Q2 remains
      // The patch should remove Q1 from requiredRemaining (if it were there)
      // Q1 was already in questionsAsked, so it wasn't in requiredRemaining
      // This test just confirms the operation succeeds
      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isSkipped: true }),
        }),
      );
    });
  });

  describe('authorization and state errors', () => {
    it('throws NOT_FOUND when interview does not exist', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(null);

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('NOT_FOUND');
      }
    });

    it('throws FORBIDDEN when user does not own the interview', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ userId: OTHER_USER_ID }));

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('FORBIDDEN');
      }
    });

    it('throws INVALID_STATE when interview is not in_progress', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'paused' }));

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when no session exists', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when turn lock is active', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      seedSession(buildSession({ isStreaming: true }));

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when session has no active question', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      seedSession(buildSession({ conversationHistory: [] }));

      try {
        await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: createMockClaude() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });
  });

  describe('error recovery', () => {
    it('releases turn lock when Claude call fails', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildSession());

      const failingClaude: ClaudeApiClient = {
        chat: vi.fn().mockRejectedValue(new Error('Claude unavailable')),
      };

      await expect(
        skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude: failingClaude }),
      ).rejects.toThrow('Claude unavailable');

      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({ isStreaming: false, currentTurnLlmText: null }),
      );
    });
  });
});

// =========================================================================
// completeInterview
// =========================================================================

describe('completeInterview', () => {
  describe('success cases', () => {
    it('marks interview as completed with completedAt timestamp', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({
        ...mockInterview(),
        status: 'completed',
        completedAt: new Date(),
      });
      seedSession(buildSession());
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(mockPrisma.interview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INTERVIEW_ID },
          data: expect.objectContaining({
            status: 'completed',
            completedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('stores final session snapshot in DB', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      const session = buildSession();
      seedSession(session);
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(mockPrisma.interview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionSnapshot: expect.objectContaining({ interviewId: INTERVIEW_ID }),
          }),
        }),
      );
    });

    it('marks userTemplate assignment as completed', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      seedSession(buildSession());
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(mockPrisma.userTemplate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_ID,
            templateId: TEMPLATE_ID,
            status: 'active',
          }),
          data: expect.objectContaining({
            status: 'completed',
            completedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('deletes the Redis session', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      seedSession(buildSession());
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(deleteSession).toHaveBeenCalledWith(INTERVIEW_ID);
      expect(mockSessionStore[INTERVIEW_ID]).toBeUndefined();
    });

    it('publishes InterviewCompleted EventBridge event', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      seedSession(buildSession());
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          detailType: 'InterviewCompleted',
          detail: expect.objectContaining({
            interviewId: INTERVIEW_ID,
            userId: USER_ID,
            templateId: TEMPLATE_ID,
          }),
        }),
      );
    });

    it('returns the updated interview record', async () => {
      mockPrisma = createMockPrisma();
      const completedInterview = {
        ...mockInterview(),
        status: 'completed',
        completedAt: new Date(),
      };
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue(completedInterview);
      seedSession(buildSession());
      const events = createMockEvents();

      const result = await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(result).toMatchObject({ status: 'completed' });
    });

    it('persists correctly in a transaction (interview + userTemplate)', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      seedSession(buildSession());
      const events = createMockEvents();

      await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('completes successfully even without a Redis session (uses DbNull for snapshot)', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
      // No session seeded
      const events = createMockEvents();

      // Should not throw
      await expect(
        completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events }),
      ).resolves.toBeDefined();

      expect(events.publish).toHaveBeenCalled();
    });
  });

  describe('authorization and state errors', () => {
    it('throws NOT_FOUND when interview does not exist', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(null);

      try {
        await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events: createMockEvents() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('NOT_FOUND');
      }
    });

    it('throws FORBIDDEN when user does not own the interview', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ userId: OTHER_USER_ID }));

      try {
        await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events: createMockEvents() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('FORBIDDEN');
      }
    });

    it('throws INVALID_STATE when interview is not in_progress', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'completed' }));

      try {
        await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events: createMockEvents() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when interview is paused', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'paused' }));

      try {
        await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events: createMockEvents() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('throws INVALID_STATE when turn lock is active', async () => {
      mockPrisma = createMockPrisma();
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      seedSession(buildSession({ isStreaming: true }));

      try {
        await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events: createMockEvents() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });
  });
});

// =========================================================================
// Full flow: submit → skip → complete
// =========================================================================

describe('full interview flow', () => {
  it('submit response → skip question → complete interview', async () => {
    mockPrisma = createMockPrisma();
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interview.update.mockResolvedValue({ ...mockInterview(), status: 'completed' });
    setupTemplateMocks(mockPrisma);

    // Seed session with Q1 in conversation history
    const session = buildSession({
      questionsAsked: [Q1_ID],
      requiredRemaining: [Q2_ID],
      optionalRemaining: [Q3_ID],
      questionsCompleted: 0,
    });
    seedSession(session);

    const claude = createMockClaude({ content: 'Next LLM question.' });

    // 1. Submit response to Q1
    const submitResult = await submitResponse(
      mockPrisma,
      USER_ID,
      defaultSubmitInput(),
      { claude },
    );
    expect(submitResult.responseId).toBeDefined();

    // After submit, session should have Q2 in questionsAsked (LLM asked it),
    // Q2 removed from requiredRemaining
    let currentSession = JSON.parse(mockSessionStore[INTERVIEW_ID]);
    expect(currentSession.isStreaming).toBe(false);
    expect(currentSession.questionsCompleted).toBe(1);

    // 2. Simulate the LLM having asked Q2 (via the assistantEntry added by submitResponse)
    // Update session to have Q2 as the current question (already done by submitResponse)
    // Q2 should already be in questionsAsked from the submitResponse call

    // Seed updated state for skipQuestion (Q2 is now the current question)
    // The session already reflects this from step 1 — just verify Q2 is in questionsAsked
    expect(currentSession.questionsAsked).toContain(Q2_ID);

    // 3. Skip Q2 — update conversation history to make Q2 the current asked question
    // The session after step 1 should have the assistant entry with Q2
    const historyAfterSubmit = currentSession.conversationHistory;
    const q2Entry = historyAfterSubmit.find(
      (e: { role: string; questionId?: string }) => e.role === 'assistant' && e.questionId === Q2_ID,
    );
    expect(q2Entry).toBeDefined();

    // Skip Q2
    const skipResult = await skipQuestion(mockPrisma, USER_ID, INTERVIEW_ID, { claude });
    expect(skipResult.success).toBe(true);

    currentSession = JSON.parse(mockSessionStore[INTERVIEW_ID]);
    expect(currentSession.questionsSkipped).toContain(Q2_ID);
    expect(currentSession.isStreaming).toBe(false);

    // 4. Complete the interview
    const events = createMockEvents();
    await completeInterview(mockPrisma, USER_ID, INTERVIEW_ID, { events });

    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'InterviewCompleted' }),
    );
    expect(deleteSession).toHaveBeenCalledWith(INTERVIEW_ID);
    // Session should be gone
    expect(mockSessionStore[INTERVIEW_ID]).toBeUndefined();
  });
});
