// ---------------------------------------------------------------------------
// Unit Tests — Draft Service (saveDraft)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveDraft,
  getCurrentQuestionId,
  VALID_INPUT_MODES,
  type SaveDraftInput,
} from '../services/draftService';
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
  };
});

import { getSession, updateSession } from '../services/session';

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

let draftIdCounter = 0;

function createMockPrisma() {
  return {
    interview: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    responseDraft: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: `draft-${++draftIdCounter}`,
        interviewId: data.interviewId,
        questionId: data.questionId ?? null,
        draftNumber: data.draftNumber,
        content: data.content,
        inputMode: data.inputMode,
        sttConfidenceScore: data.sttConfidenceScore ?? null,
        audioUploadStatus: data.audioUploadStatus,
        createdAt: new Date(),
      })),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockPrisma = any;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const USER_ID = 'user-001';
const OTHER_USER_ID = 'user-002';
const INTERVIEW_ID = 'interview-001';
const QUESTION_ID = 'question-001';

function mockInterview(overrides?: Record<string, unknown>) {
  return {
    id: INTERVIEW_ID,
    userId: USER_ID,
    status: 'in_progress',
    ...overrides,
  };
}

function buildSession(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    interviewId: INTERVIEW_ID,
    templateId: 'template-001',
    userId: USER_ID,
    conversationHistory: [
      { role: 'assistant', content: 'Here is your question.', questionId: QUESTION_ID, sequenceNumber: 1 },
    ],
    questionsAsked: [QUESTION_ID],
    questionsSkipped: [],
    bucketsCovered: {},
    requiredRemaining: [],
    optionalRemaining: [],
    triggeredFollowups: [],
    currentTranscriptBuffer: '',
    currentDrafts: [],
    totalExpectedQuestions: 3,
    questionsCompleted: 0,
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
    isStreaming: false,
    currentTurnLlmText: null,
    ...overrides,
  };
}

function seedSession(session: InterviewSession): void {
  mockSessionStore[session.interviewId] = JSON.stringify(session);
}

function defaultInput(overrides?: Partial<SaveDraftInput>): SaveDraftInput {
  return {
    interviewId: INTERVIEW_ID,
    content: 'My draft response text',
    inputMode: 'voice',
    sttConfidenceScore: 0.95,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockPrisma: ReturnType<typeof createMockPrisma>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma = createMockPrisma();
  draftIdCounter = 0;
  // Clear session store
  for (const key of Object.keys(mockSessionStore)) {
    delete mockSessionStore[key];
  }
});

// ---------------------------------------------------------------------------
// getCurrentQuestionId helper
// ---------------------------------------------------------------------------

describe('getCurrentQuestionId', () => {
  it('returns the questionId from the last assistant message with a questionId', () => {
    const session = buildSession({
      conversationHistory: [
        { role: 'assistant', content: 'Q1', questionId: 'q-1', sequenceNumber: 1 },
        { role: 'user', content: 'answer 1' },
        { role: 'assistant', content: 'Q2', questionId: 'q-2', sequenceNumber: 2 },
      ],
    });
    expect(getCurrentQuestionId(session)).toBe('q-2');
  });

  it('returns null when conversation history is empty', () => {
    const session = buildSession({ conversationHistory: [] });
    expect(getCurrentQuestionId(session)).toBeNull();
  });

  it('returns null when no assistant message has a questionId', () => {
    const session = buildSession({
      conversationHistory: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(getCurrentQuestionId(session)).toBeNull();
  });

  it('skips assistant messages without questionId', () => {
    const session = buildSession({
      conversationHistory: [
        { role: 'assistant', content: 'Q1', questionId: 'q-1', sequenceNumber: 1 },
        { role: 'user', content: 'answer' },
        { role: 'assistant', content: 'Interesting, tell me more.', type: 'idle_prompt' },
      ],
    });
    expect(getCurrentQuestionId(session)).toBe('q-1');
  });
});

// ---------------------------------------------------------------------------
// saveDraft — success cases
// ---------------------------------------------------------------------------

describe('saveDraft', () => {
  describe('success cases', () => {
    it('creates a draft with draft_number 1 when no prior drafts exist', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const result = await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(result.draftNumber).toBe(1);
      expect(result.interviewId).toBe(INTERVIEW_ID);
      expect(result.questionId).toBe(QUESTION_ID);
      expect(result.content).toBe('My draft response text');
      expect(result.inputMode).toBe('voice');
      expect(result.sttConfidenceScore).toBe(0.95);
      expect(result.audioUploadStatus).toBe('pending');
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
    });

    it('auto-increments draft_number from the highest existing draft', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue({ draftNumber: 3 });
      seedSession(buildSession());

      const result = await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(result.draftNumber).toBe(4);
    });

    it('creates draft with draft_number 2 after one prior draft', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue({ draftNumber: 1 });
      seedSession(buildSession());

      const result = await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(result.draftNumber).toBe(2);
    });

    it('queries for the highest draft_number with correct interviewId and questionId', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(mockPrisma.responseDraft.findFirst).toHaveBeenCalledWith({
        where: { interviewId: INTERVIEW_ID, questionId: QUESTION_ID },
        orderBy: { draftNumber: 'desc' },
        select: { draftNumber: true },
      });
    });

    it('sets audioUploadStatus to not_applicable for text input mode', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const result = await saveDraft(
        mockPrisma as MockPrisma,
        USER_ID,
        defaultInput({ inputMode: 'text', sttConfidenceScore: null }),
      );

      expect(result.audioUploadStatus).toBe('not_applicable');
      expect(result.inputMode).toBe('text');
    });

    it('sets audioUploadStatus to pending for voice input mode', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const result = await saveDraft(
        mockPrisma as MockPrisma,
        USER_ID,
        defaultInput({ inputMode: 'voice' }),
      );

      expect(result.audioUploadStatus).toBe('pending');
    });

    it('sets audioUploadStatus to pending for edited input mode', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const result = await saveDraft(
        mockPrisma as MockPrisma,
        USER_ID,
        defaultInput({ inputMode: 'edited' }),
      );

      expect(result.audioUploadStatus).toBe('pending');
    });

    it('handles null sttConfidenceScore', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const result = await saveDraft(
        mockPrisma as MockPrisma,
        USER_ID,
        defaultInput({ sttConfidenceScore: null }),
      );

      expect(result.sttConfidenceScore).toBeNull();
    });

    it('handles undefined sttConfidenceScore', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      const input = defaultInput();
      delete (input as Record<string, unknown>).sttConfidenceScore;

      const result = await saveDraft(mockPrisma as MockPrisma, USER_ID, input);

      expect(result.sttConfidenceScore).toBeNull();
    });

    it('handles null questionId when no question has been asked yet', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession({ conversationHistory: [] }));

      const result = await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(result.questionId).toBeNull();
      expect(mockPrisma.responseDraft.findFirst).toHaveBeenCalledWith({
        where: { interviewId: INTERVIEW_ID, questionId: null },
        orderBy: { draftNumber: 'desc' },
        select: { draftNumber: true },
      });
    });

    it('appends draft to session currentDrafts via updateSession', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      seedSession(buildSession());

      await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({
          currentDrafts: [
            expect.objectContaining({
              content: 'My draft response text',
              inputMode: 'voice',
              sttConfidenceScore: 0.95,
            }),
          ],
          lastActivityAt: expect.any(String),
        }),
      );
    });

    it('preserves existing currentDrafts when appending', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      mockPrisma.responseDraft.findFirst.mockResolvedValue(null);
      const existingDraft = {
        content: 'old draft',
        inputMode: 'voice' as const,
        createdAt: new Date().toISOString(),
      };
      seedSession(buildSession({ currentDrafts: [existingDraft] }));

      await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());

      expect(updateSession).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({
          currentDrafts: [
            existingDraft,
            expect.objectContaining({ content: 'My draft response text' }),
          ],
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    it('throws VALIDATION_ERROR for invalid inputMode', async () => {
      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput({ inputMode: 'invalid' })),
      ).rejects.toThrow('Invalid input mode');
    });

    it('throws VALIDATION_ERROR for empty inputMode', async () => {
      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput({ inputMode: '' })),
      ).rejects.toThrow('Invalid input mode');
    });
  });

  // -------------------------------------------------------------------------
  // Authorization and state errors
  // -------------------------------------------------------------------------

  describe('authorization and state errors', () => {
    it('throws NOT_FOUND when interview does not exist', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(null);

      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput()),
      ).rejects.toThrow('Interview not found');
    });

    it('throws FORBIDDEN when interview belongs to a different user', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ userId: OTHER_USER_ID }));

      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput()),
      ).rejects.toThrow('Not authorized to save draft for this interview');
    });

    it('throws INVALID_STATE when interview is not in_progress', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'paused' }));

      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput()),
      ).rejects.toThrow('Interview is not in progress');
    });

    it('throws INVALID_STATE when interview is completed', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'completed' }));

      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput()),
      ).rejects.toThrow('Interview is not in progress');
    });

    it('throws INVALID_STATE when no Redis session exists', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      // No session seeded

      await expect(
        saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput()),
      ).rejects.toThrow('No active session found for interview');
    });
  });

  // -------------------------------------------------------------------------
  // Error code verification
  // -------------------------------------------------------------------------

  describe('error codes', () => {
    function getErrorCode(err: unknown): string | undefined {
      const e = err as { extensions?: { code?: string } };
      return e.extensions?.code;
    }

    it('NOT_FOUND for missing interview', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(null);

      try {
        await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('NOT_FOUND');
      }
    });

    it('FORBIDDEN for wrong user', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ userId: OTHER_USER_ID }));

      try {
        await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('FORBIDDEN');
      }
    });

    it('INVALID_STATE for non-in_progress interview', async () => {
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview({ status: 'completed' }));

      try {
        await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput());
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('INVALID_STATE');
      }
    });

    it('VALIDATION_ERROR for invalid inputMode', async () => {
      try {
        await saveDraft(mockPrisma as MockPrisma, USER_ID, defaultInput({ inputMode: 'bad' }));
        expect.fail('should have thrown');
      } catch (err) {
        expect(getErrorCode(err)).toBe('VALIDATION_ERROR');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// VALID_INPUT_MODES
// ---------------------------------------------------------------------------

describe('VALID_INPUT_MODES', () => {
  it('contains voice, text, and edited', () => {
    expect(VALID_INPUT_MODES.has('voice')).toBe(true);
    expect(VALID_INPUT_MODES.has('text')).toBe(true);
    expect(VALID_INPUT_MODES.has('edited')).toBe(true);
  });

  it('does not contain invalid modes', () => {
    expect(VALID_INPUT_MODES.has('typing')).toBe(false);
    expect(VALID_INPUT_MODES.has('')).toBe(false);
  });
});
