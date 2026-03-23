// ---------------------------------------------------------------------------
// Interview Session Service Tests — startInterview, pauseInterview, resumeInterview
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  startInterview,
  pauseInterview,
  resumeInterview,
} from '../services/interviewSession';

// ---------------------------------------------------------------------------
// Mock Redis session operations
// ---------------------------------------------------------------------------

const mockSessionStore: Record<string, string> = {};

vi.mock('../services/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/session')>();
  return {
    ...original,
    createSession: vi.fn(async (session: unknown) => {
      const s = session as { interviewId: string };
      mockSessionStore[s.interviewId] = JSON.stringify(session);
    }),
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
    refreshSessionTTL: vi.fn(async () => true),
    setSessionPausedTTL: vi.fn(async () => true),
  };
});

// Import mocked session functions for assertions
import {
  createSession,
  getSession,
  setSessionPausedTTL,
  refreshSessionTTL,
} from '../services/session';

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    userConsentRecord: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userTemplate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    interviewTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    interview: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    templateQuestion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    interviewResponse: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockPrisma = any;

const USER_ID = 'user-001';
const TEMPLATE_ID = 'template-001';
const INTERVIEW_ID = 'interview-001';
const ADMIN_ID = 'admin-001';
const QUESTION_IDS = ['q-001', 'q-002', 'q-003'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectErrorCode(err: unknown, code: string) {
  expect(err).toBeDefined();
  const e = err as { extensions?: { code?: string } };
  expect(e.extensions?.code).toBe(code);
}

function setupStartInterviewMocks(prisma: MockPrisma) {
  // consent granted
  prisma.userConsentRecord.findMany.mockResolvedValue([
    { consentType: 'data_processing', revokedAt: null },
    { consentType: 'audio_recording', revokedAt: null },
    { consentType: 'ai_interaction', revokedAt: null },
  ]);

  // active assignment
  prisma.userTemplate.findFirst.mockResolvedValue({
    id: 'assignment-001',
    userId: USER_ID,
    templateId: TEMPLATE_ID,
    status: 'active',
  });

  // published template
  prisma.interviewTemplate.findUnique.mockResolvedValue({
    id: TEMPLATE_ID,
    name: 'Test Template',
    status: 'published',
  });

  // no existing active interview
  prisma.interview.findFirst.mockResolvedValue(null);

  // template questions
  prisma.templateQuestion.findMany.mockResolvedValue([
    { id: 'tq-1', questionId: QUESTION_IDS[0], sequenceOrder: 1, categoryBucket: 'motivation', isRequired: true, followupTriggers: [] },
    { id: 'tq-2', questionId: QUESTION_IDS[1], sequenceOrder: 2, categoryBucket: 'process', isRequired: true, followupTriggers: [] },
    { id: 'tq-3', questionId: QUESTION_IDS[2], sequenceOrder: 3, categoryBucket: 'motivation', isRequired: false, followupTriggers: [] },
  ]);

  // interview creation
  prisma.interview.create.mockResolvedValue({
    id: INTERVIEW_ID,
    userId: USER_ID,
    templateId: TEMPLATE_ID,
    status: 'in_progress',
    startedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the mock session store
  for (const key of Object.keys(mockSessionStore)) {
    delete mockSessionStore[key];
  }
  // Default: consent bypass off
  process.env.CONSENT_BYPASS = 'false';
});

// =========================================================================
// startInterview
// =========================================================================

describe('startInterview', () => {
  it('creates interview and initializes Redis session', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);

    const result = await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);

    expect(result.id).toBe(INTERVIEW_ID);
    expect(result.status).toBe('in_progress');
    expect(result.startedAt).toBeDefined();

    // Verify DB interview was created
    expect(prisma.interview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          templateId: TEMPLATE_ID,
          status: 'in_progress',
        }),
      }),
    );

    // Verify Redis session was created
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: INTERVIEW_ID,
        templateId: TEMPLATE_ID,
        userId: USER_ID,
        requiredRemaining: [QUESTION_IDS[0], QUESTION_IDS[1]],
        optionalRemaining: [QUESTION_IDS[2]],
        totalExpectedQuestions: 3,
        isStreaming: false,
        currentTurnLlmText: null,
      }),
    );
  });

  it('rejects when consent is missing', async () => {
    const prisma = createMockPrisma();
    // Only data_processing consent granted
    prisma.userConsentRecord.findMany.mockResolvedValue([
      { consentType: 'data_processing', revokedAt: null },
    ]);

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'CONSENT_REQUIRED');
    }
  });

  it('skips consent check when CONSENT_BYPASS=true', async () => {
    process.env.CONSENT_BYPASS = 'true';
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    // No consent records
    prisma.userConsentRecord.findMany.mockResolvedValue([]);

    const result = await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
    expect(result.status).toBe('in_progress');
    expect(prisma.userConsentRecord.findMany).not.toHaveBeenCalled();
  });

  it('rejects when user has no active assignment', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    prisma.userTemplate.findFirst.mockResolvedValue(null);

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'FORBIDDEN');
    }
  });

  it('rejects when template is not published', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: TEMPLATE_ID,
      name: 'Draft Template',
      status: 'draft',
    });

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });

  it('rejects when template not found', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    prisma.interviewTemplate.findUnique.mockResolvedValue(null);

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'NOT_FOUND');
    }
  });

  it('rejects when user already has an active interview', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    prisma.interview.findFirst.mockResolvedValue({
      id: 'other-interview',
      status: 'in_progress',
    });

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });

  it('rejects when template has no questions', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);
    prisma.templateQuestion.findMany.mockResolvedValue([]);

    try {
      await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });

  it('correctly separates required and optional questions', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);

    await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredRemaining: [QUESTION_IDS[0], QUESTION_IDS[1]],
        optionalRemaining: [QUESTION_IDS[2]],
      }),
    );
  });

  it('initializes bucket tracking from template questions', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);

    await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketsCovered: { motivation: 0, process: 0 },
      }),
    );
  });
});

// =========================================================================
// pauseInterview
// =========================================================================

describe('pauseInterview', () => {
  it('snapshots session and sets paused status', async () => {
    const prisma = createMockPrisma();

    // Active interview in DB
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'in_progress',
    });

    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date(),
    });

    // Warm session in Redis
    mockSessionStore[INTERVIEW_ID] = JSON.stringify({
      interviewId: INTERVIEW_ID,
      templateId: TEMPLATE_ID,
      userId: USER_ID,
      questionsAsked: ['q-001'],
      questionsCompleted: 1,
      conversationHistory: [],
    });

    const result = await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    expect(result.status).toBe('paused');
    expect(result.pausedAt).toBeDefined();

    // Verify session snapshot saved to DB
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTERVIEW_ID },
        data: expect.objectContaining({
          status: 'paused',
          sessionSnapshot: expect.objectContaining({
            interviewId: INTERVIEW_ID,
            questionsAsked: ['q-001'],
          }),
        }),
      }),
    );

    // Verify Redis TTL was set to 15 minutes
    expect(setSessionPausedTTL).toHaveBeenCalledWith(INTERVIEW_ID);
  });

  it('pauses even without Redis session (snapshot is null)', async () => {
    const prisma = createMockPrisma();

    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'in_progress',
    });

    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date(),
    });

    const result = await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    expect(result.status).toBe('paused');
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionSnapshot: Prisma.DbNull,
        }),
      }),
    );
    expect(setSessionPausedTTL).not.toHaveBeenCalled();
  });

  it('rejects when interview not found', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(null);

    try {
      await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'NOT_FOUND');
    }
  });

  it('rejects when user does not own the interview', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: 'other-user',
      status: 'in_progress',
    });

    try {
      await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'FORBIDDEN');
    }
  });

  it('rejects when interview is not in_progress', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'completed',
    });

    try {
      await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });

  it('rejects when interview is already paused', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'paused',
    });

    try {
      await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });
});

// =========================================================================
// resumeInterview
// =========================================================================

describe('resumeInterview', () => {
  it('warm resume: uses existing Redis session', async () => {
    const prisma = createMockPrisma();

    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'paused',
      sessionSnapshot: null,
    });

    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'in_progress',
      pausedAt: null,
    });

    // Warm session in Redis
    mockSessionStore[INTERVIEW_ID] = JSON.stringify({
      interviewId: INTERVIEW_ID,
      templateId: TEMPLATE_ID,
      userId: USER_ID,
      questionsAsked: ['q-001'],
      questionsCompleted: 1,
      conversationHistory: [],
      lastActivityAt: '2026-03-22T00:00:00.000Z',
      idleWarningShown: true,
      isStreaming: false,
      currentTurnLlmText: null,
    });

    const result = await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    expect(result.status).toBe('in_progress');
    expect(result.resumedFromSnapshot).toBe(false);

    // Verify TTL was refreshed to active TTL
    expect(refreshSessionTTL).toHaveBeenCalledWith(INTERVIEW_ID, 14400);

    // Verify DB was updated
    expect(prisma.interview.update).toHaveBeenCalledWith({
      where: { id: INTERVIEW_ID },
      data: { status: 'in_progress', pausedAt: null },
    });
  });

  it('cold resume: reconstructs from DB snapshot', async () => {
    const prisma = createMockPrisma();

    const snapshot = {
      interviewId: INTERVIEW_ID,
      templateId: TEMPLATE_ID,
      userId: USER_ID,
      conversationHistory: [
        { role: 'assistant', content: 'Tell me about...', questionId: 'q-001', sequenceNumber: 1 },
        { role: 'user', content: 'Well, I think...', inputMode: 'voice' },
      ],
      questionsAsked: ['q-001'],
      questionsSkipped: [],
      bucketsCovered: { motivation: 1, process: 0 },
      requiredRemaining: ['q-001', 'q-002'],
      optionalRemaining: ['q-003'],
      triggeredFollowups: [],
      currentTranscriptBuffer: '',
      currentDrafts: [],
      totalExpectedQuestions: 3,
      questionsCompleted: 1,
      lastActivityAt: '2026-03-22T00:00:00.000Z',
      idleWarningShown: false,
      isStreaming: false,
      currentTurnLlmText: null,
    };

    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'paused',
      sessionSnapshot: snapshot,
    });

    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'in_progress',
      pausedAt: null,
    });

    // DB responses (one answered since snapshot)
    prisma.interviewResponse.findMany.mockResolvedValue([
      { questionId: 'q-001', isSkipped: false, sequenceNumber: 1 },
    ]);

    // No warm session in Redis
    const result = await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    expect(result.status).toBe('in_progress');
    expect(result.resumedFromSnapshot).toBe(true);

    // Verify session was recreated in Redis from snapshot
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: INTERVIEW_ID,
        questionsAsked: ['q-001'],
        requiredRemaining: ['q-002'],
        optionalRemaining: ['q-003'],
        isStreaming: false,
        currentTurnLlmText: null,
        idleWarningShown: false,
      }),
    );
  });

  it('cold resume: merges skipped questions from DB', async () => {
    const prisma = createMockPrisma();

    const snapshot = {
      interviewId: INTERVIEW_ID,
      templateId: TEMPLATE_ID,
      userId: USER_ID,
      conversationHistory: [],
      questionsAsked: [],
      questionsSkipped: [],
      bucketsCovered: { motivation: 0 },
      requiredRemaining: ['q-001', 'q-002'],
      optionalRemaining: ['q-003'],
      triggeredFollowups: [],
      currentTranscriptBuffer: '',
      currentDrafts: [],
      totalExpectedQuestions: 3,
      questionsCompleted: 0,
      lastActivityAt: '2026-03-22T00:00:00.000Z',
      idleWarningShown: false,
      isStreaming: false,
      currentTurnLlmText: null,
    };

    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'paused',
      sessionSnapshot: snapshot,
    });

    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'in_progress',
    });

    // q-001 was answered, q-002 was skipped
    prisma.interviewResponse.findMany.mockResolvedValue([
      { questionId: 'q-001', isSkipped: false, sequenceNumber: 1 },
      { questionId: 'q-002', isSkipped: true, sequenceNumber: 2 },
    ]);

    const result = await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    expect(result.resumedFromSnapshot).toBe(true);

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        questionsAsked: ['q-001'],
        questionsSkipped: ['q-002'],
        questionsCompleted: 1,
        requiredRemaining: [],
        optionalRemaining: ['q-003'],
      }),
    );
  });

  it('rejects when interview not found', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(null);

    try {
      await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'NOT_FOUND');
    }
  });

  it('rejects when user does not own the interview', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: 'other-user',
      status: 'paused',
    });

    try {
      await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'FORBIDDEN');
    }
  });

  it('rejects when interview is not paused', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'in_progress',
    });

    try {
      await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });

  it('rejects when no snapshot available for cold resume', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      status: 'paused',
      sessionSnapshot: null,
    });

    // No Redis session (cold resume attempt)

    try {
      await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expectErrorCode(err, 'INVALID_STATE');
    }
  });
});

// =========================================================================
// Full Pause/Resume Lifecycle
// =========================================================================

describe('pause/resume lifecycle', () => {
  it('start → pause → warm resume', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);

    // 1. Start
    const started = await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
    expect(started.status).toBe('in_progress');

    // Verify session is in mock store
    expect(mockSessionStore[INTERVIEW_ID]).toBeDefined();

    // 2. Pause
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'in_progress',
    });
    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date(),
    });

    const paused = await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
    expect(paused.status).toBe('paused');
    expect(setSessionPausedTTL).toHaveBeenCalledWith(INTERVIEW_ID);

    // Session still in mock store (warm)
    expect(mockSessionStore[INTERVIEW_ID]).toBeDefined();

    // 3. Warm Resume
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'paused',
      sessionSnapshot: JSON.parse(mockSessionStore[INTERVIEW_ID]),
    });
    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'in_progress',
      pausedAt: null,
    });

    const resumed = await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.resumedFromSnapshot).toBe(false);
    expect(refreshSessionTTL).toHaveBeenCalled();
  });

  it('start → pause → cold resume (Redis expired)', async () => {
    const prisma = createMockPrisma();
    setupStartInterviewMocks(prisma);

    // 1. Start
    const started = await startInterview(prisma as MockPrisma, USER_ID, TEMPLATE_ID);
    expect(started.status).toBe('in_progress');

    // Save snapshot before clearing
    const sessionSnapshot = JSON.parse(mockSessionStore[INTERVIEW_ID]);

    // 2. Pause
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'in_progress',
    });
    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date(),
    });

    await pauseInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);

    // Simulate Redis TTL expiry
    delete mockSessionStore[INTERVIEW_ID];

    // 3. Cold Resume
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW_ID,
      userId: USER_ID,
      templateId: TEMPLATE_ID,
      status: 'paused',
      sessionSnapshot,
    });
    prisma.interview.update.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'in_progress',
      pausedAt: null,
    });
    prisma.interviewResponse.findMany.mockResolvedValue([]);

    const resumed = await resumeInterview(prisma as MockPrisma, USER_ID, INTERVIEW_ID);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.resumedFromSnapshot).toBe(true);

    // Verify session was recreated in Redis
    expect(mockSessionStore[INTERVIEW_ID]).toBeDefined();
    const recreatedSession = JSON.parse(mockSessionStore[INTERVIEW_ID]);
    expect(recreatedSession.interviewId).toBe(INTERVIEW_ID);
    expect(recreatedSession.isStreaming).toBe(false);
  });
});
