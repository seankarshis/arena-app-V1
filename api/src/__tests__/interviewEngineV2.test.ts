// ---------------------------------------------------------------------------
// Integration Tests — submitResponse v2-coverage path (M2d)
//
// Covers the new LLM-driven orchestration flow from conversation-protocol-
// spec-v4 §4 and ADRs 008/009/010/011/014:
//
//   * Happy-path: well-formed LLM output → coverage applied, flagged items
//     persisted, emitters fire, response row + outbox row written in one
//     Prisma transaction, SSE receives only the pre-delimiter text.
//   * Parse failures: invalid_json once vs three consecutive.
//   * close_interview: satisfied vs unsatisfied completion criterion.
//   * Partial parse (unknown questionId): partialApplied telemetry, valid
//     entries survive.
//   * v1-pool dispatch: legacy path is invoked, new path is not.
//   * SSE delimiter streaming: pre-delimiter tokens flush, post-delimiter
//     bytes never reach the onPreDelimiterToken callback.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  submitResponse,
  DelimiterBoundaryDetector,
  applyCacheBreakpoint,
  type ClaudeApiClient,
  type ClaudeStreamingClient,
  type ClaudeStreamingResult,
  type SubmitResponseInput,
} from '../services/interviewEngine';
import type { InterviewSession } from '../services/session';
import type { CoverageEntry } from '../services/sessionState';

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

// ---------------------------------------------------------------------------
// Mock ClickHouse writer so emit calls are observable without network I/O
// ---------------------------------------------------------------------------

vi.mock('../observability/clickhouseWriter', () => ({
  clickHouseWrite: vi.fn(),
}));

import { clickHouseWrite } from '../observability/clickhouseWriter';
const mockClickHouseWrite = vi.mocked(clickHouseWrite);

// ---------------------------------------------------------------------------
// Mock legacy submitResponse path: we spy on the old promptConstructor
// helper to confirm routing — v1-pool sessions invoke it; v2-coverage
// never touches it.
// ---------------------------------------------------------------------------

import * as promptConstructor from '../services/promptConstructor';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const USER_ID = 'user-001';
const INTERVIEW_ID = 'interview-001';
const TEMPLATE_ID = 'template-001';
const Q1_ID = '11111111-1111-1111-1111-111111111111';
const Q2_ID = '22222222-2222-2222-2222-222222222222';
const Q3_ID = '33333333-3333-3333-3333-333333333333';

// ---------------------------------------------------------------------------
// Mock Prisma factory — tracks $transaction calls so tests can assert the
// outbox row was inserted in the same call as the response row.
// ---------------------------------------------------------------------------

let responseIdCounter = 0;
let flaggedItemIdCounter = 0;

function createMockPrisma() {
  const transactionSpy = vi.fn();

  const prisma = {
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
    enrichmentOutbox: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: `outbox-${++responseIdCounter}`,
        ...data,
        createdAt: new Date(),
      })),
    },
    flaggedItem: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: `flag-${++flaggedItemIdCounter}`,
        ...data,
        createdAt: new Date(),
      })),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ name: 'Alex Rivers' }),
    },
    userTemplate: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn().mockImplementation(async (cbOrOps: unknown) => {
      transactionSpy(cbOrOps);
      if (typeof cbOrOps === 'function') {
        return cbOrOps(prisma);
      }
      return Promise.all(cbOrOps as Promise<unknown>[]);
    }),
  };

  return { prisma, transactionSpy };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockPrisma = any;

// ---------------------------------------------------------------------------
// Claude client factories
// ---------------------------------------------------------------------------

function createMockLegacyClaude(): ClaudeApiClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'Legacy LLM response.',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 200,
      completionTokens: 80,
      latencyMs: 450,
    }),
  };
}

function createMockStreamingClaude(
  fullContent: string,
  overrides: Partial<ClaudeStreamingResult> = {},
): ClaudeStreamingClient & { streamCallCount: () => number; lastOnTokenEmissions: () => string[] } {
  let callCount = 0;
  let lastEmissions: string[] = [];

  const client: ClaudeStreamingClient = {
    async stream({ onPreDelimiterToken }) {
      callCount++;
      lastEmissions = [];

      // Simulate token-by-token streaming through the DelimiterBoundaryDetector
      // so we verify the delimiter-aware pass-through logic end-to-end.
      const detector = new DelimiterBoundaryDetector('---STATE_UPDATE---');
      const chunkSize = 13;
      for (let i = 0; i < fullContent.length; i += chunkSize) {
        const token = fullContent.slice(i, i + chunkSize);
        const emit = detector.ingest(token);
        if (emit && onPreDelimiterToken) {
          onPreDelimiterToken(emit);
          lastEmissions.push(emit);
        }
      }
      const tail = detector.flushIfNoDelimiter();
      if (tail && onPreDelimiterToken) {
        onPreDelimiterToken(tail);
        lastEmissions.push(tail);
      }

      return {
        fullContent,
        preDelimiterContent: detector.getPreDelimiterContent(fullContent),
        model: 'claude-sonnet-4-20250514',
        promptTokens: 1234,
        completionTokens: 567,
        latencyMs: 890,
        ...overrides,
      };
    },
  };

  return Object.assign(client, {
    streamCallCount: () => callCount,
    lastOnTokenEmissions: () => lastEmissions,
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildV2Session(overrides?: Partial<InterviewSession>): InterviewSession {
  const coverage: Record<string, CoverageEntry> = {
    [Q1_ID]: {
      status: 'not_started',
      confidence: null,
      turnNumbers: [],
      summary: null,
    },
    [Q2_ID]: {
      status: 'not_started',
      confidence: null,
      turnNumbers: [],
      summary: null,
    },
    [Q3_ID]: {
      status: 'not_started',
      confidence: null,
      turnNumbers: [],
      summary: null,
    },
  };

  return {
    interviewId: INTERVIEW_ID,
    templateId: TEMPLATE_ID,
    userId: USER_ID,
    conversationHistory: [
      {
        role: 'assistant',
        content: "Let's start with your biggest cost drivers right now.",
        questionId: Q1_ID,
        sequenceNumber: 1,
      },
    ],
    questionsAsked: [Q1_ID],
    questionsSkipped: [],
    bucketsCovered: { cost: 1, process: 0 },
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
    currentTurnLlmText: "Let's start with your biggest cost drivers right now.",
    sessionVersion: 'v2-coverage',
    coverage,
    activeThreads: [],
    factsLedger: [],
    rapportNotes: [],
    consecutiveParseFailures: 0,
    ...overrides,
  };
}

function buildV1Session(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    interviewId: INTERVIEW_ID,
    templateId: TEMPLATE_ID,
    userId: USER_ID,
    conversationHistory: [
      {
        role: 'assistant',
        content: 'Legacy phrased Q1 here.',
        questionId: Q1_ID,
        sequenceNumber: 1,
      },
    ],
    questionsAsked: [Q1_ID],
    questionsSkipped: [],
    bucketsCovered: { cost: 1 },
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
    currentTurnLlmText: 'Legacy phrased Q1 here.',
    // No sessionVersion → treated as v1-pool
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
  intent?: string | null;
  sensitivityLevel?: 'STANDARD' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
  adminNotes?: string | null;
}) {
  return {
    id: `tq-${questionId}`,
    questionId,
    categoryBucket: opts?.categoryBucket ?? 'cost',
    isRequired: opts?.isRequired ?? true,
    sequenceOrder: opts?.sequenceOrder ?? 1,
    followupTriggers: [],
    adminNotes: opts?.adminNotes ?? null,
    question: {
      text: opts?.text ?? `Question text for ${questionId}`,
      intent: opts?.intent ?? null,
      sensitivityLevel: opts?.sensitivityLevel ?? 'STANDARD',
      questionTags: [],
    },
  };
}

function setupTemplateMocks(prisma: MockPrisma) {
  prisma.interviewTemplate.findUnique.mockResolvedValue({
    id: TEMPLATE_ID,
    name: 'Infrastructure Audit',
    description: 'Cost and process review',
    status: 'published',
    systemPrompt: null,
  });
  prisma.templateQuestion.findMany.mockResolvedValue([
    mockTemplateQuestion(Q1_ID, { sequenceOrder: 1, categoryBucket: 'cost' }),
    mockTemplateQuestion(Q2_ID, { sequenceOrder: 2, categoryBucket: 'process' }),
    mockTemplateQuestion(Q3_ID, {
      sequenceOrder: 3,
      categoryBucket: 'culture',
      isRequired: false,
    }),
  ]);
}

function defaultSubmitInput(overrides?: Partial<SubmitResponseInput>): SubmitResponseInput {
  return {
    interviewId: INTERVIEW_ID,
    rawTranscription: 'We spend most on compute, storage is a distant second.',
    inputMode: 'voice',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LLM response builders — helpers that compose the two-part
// conversational-text + state-update-block wire format.
// ---------------------------------------------------------------------------

function stateBlock(body: Record<string, unknown>): string {
  return `\n---STATE_UPDATE---\n${JSON.stringify(body, null, 2)}\n---END_STATE_UPDATE---`;
}

function happyPathResponse(): string {
  const conversational =
    'That lines up with what we hear from other CIOs. What does hardware refresh look like?';
  const body = {
    decisionType: 'pivot_related',
    sourceQuestionId: Q1_ID,
    targetQuestionId: Q2_ID,
    reasoning: 'Interviewee opened cost angle; pivot to hardware refresh.',
    coverageUpdates: [
      {
        questionId: Q1_ID,
        status: 'partially_covered',
        confidence: 'medium',
        summary: 'Compute dominates; storage secondary.',
      },
    ],
    flaggedItems: [],
  };
  return conversational + stateBlock(body);
}

function closeInterviewResponse(): string {
  const conversational = 'Thank you — that gives me what I need to wrap up.';
  const body = {
    decisionType: 'close_interview',
    sourceQuestionId: Q2_ID,
    targetQuestionId: null,
    reasoning: 'All required territory covered.',
    coverageUpdates: [],
    flaggedItems: [],
  };
  return conversational + stateBlock(body);
}

function flaggedItemResponse(): string {
  const conversational = 'Interesting — tell me more about the vendor dispute.';
  const body = {
    decisionType: 'probe_deeper',
    sourceQuestionId: Q1_ID,
    targetQuestionId: Q1_ID,
    reasoning: 'Vendor dispute is out of scope but worth flagging.',
    coverageUpdates: [
      {
        questionId: Q1_ID,
        status: 'partially_covered',
        confidence: 'medium',
        summary: 'Cost driver includes vendor dispute.',
      },
    ],
    flaggedItems: [
      {
        description: 'Pending vendor dispute affecting Q3 forecast',
        priority: 'high',
        suggestedTags: ['vendor', 'legal'],
      },
    ],
  };
  return conversational + stateBlock(body);
}

function unknownQuestionIdResponse(): string {
  const conversational = 'Got it. Moving on.';
  const body = {
    decisionType: 'move_on',
    sourceQuestionId: Q1_ID,
    targetQuestionId: Q2_ID,
    reasoning: 'Mixed updates — one unknown ID.',
    coverageUpdates: [
      {
        questionId: Q1_ID,
        status: 'fully_covered',
        confidence: 'high',
        summary: 'Done.',
      },
      {
        questionId: 'unknown-id-no-match',
        status: 'partially_covered',
        confidence: 'low',
        summary: 'Should drop.',
      },
    ],
    flaggedItems: [],
  };
  return conversational + stateBlock(body);
}

function malformedJsonResponse(): string {
  const conversational = 'OK, continuing.';
  return (
    conversational +
    '\n---STATE_UPDATE---\n{ this is not json at all ]\n---END_STATE_UPDATE---'
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockPrisma: ReturnType<typeof createMockPrisma>['prisma'];
let transactionSpy: ReturnType<typeof createMockPrisma>['transactionSpy'];

beforeEach(() => {
  vi.clearAllMocks();
  mockClickHouseWrite.mockClear();
  responseIdCounter = 0;
  flaggedItemIdCounter = 0;
  for (const key of Object.keys(mockSessionStore)) {
    delete mockSessionStore[key];
  }
});

// =========================================================================
// submitResponse v2-coverage tests
// =========================================================================

describe('submitResponse v2-coverage', () => {
  describe('happy path', () => {
    it('applies coverage update, persists outbox row, emits orchestration decision', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(happyPathResponse());

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      expect(result.responseId).toBeDefined();
      expect(result.interviewStatus).toBe('in_progress');
      expect(streamingClaude.streamCallCount()).toBe(1);

      // Response row used the pre-delimiter conversational portion, not the full text.
      expect(mockPrisma.interviewResponse.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            interviewId: INTERVIEW_ID,
            questionId: Q1_ID, // sourceQuestionId from state block
            rawTranscription: 'We spend most on compute, storage is a distant second.',
            llmPromptTokens: 1234,
            llmCompletionTokens: 567,
            llmModel: 'claude-sonnet-4-20250514',
            llmLatencyMs: 890,
          }),
        }),
      );
      const savedText = mockPrisma.interviewResponse.create.mock.calls[0][0].data
        .questionTextAsAsked as string;
      expect(savedText).not.toContain('---STATE_UPDATE---');
      expect(savedText).toContain('hardware refresh');

      // Enrichment outbox written in the same transaction
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(mockPrisma.enrichmentOutbox.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          responseId: expect.any(String),
          interviewId: INTERVIEW_ID,
        }),
      });

      // Orchestration decision event emitted
      const orchEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'orchestration_decisions',
      );
      expect(orchEvent).toBeDefined();
      expect(orchEvent![1]).toMatchObject({
        decisionType: 'pivot_related',
        sourceQuestionId: Q1_ID,
        targetQuestionId: Q2_ID,
        promptTokens: 1234,
        completionTokens: 567,
        latencyMs: 890,
      });
      expect(orchEvent![2]).toMatchObject({ severity: 'INFO' });
    });

    it('emits one coverage_transitions event per coverage update', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(happyPathResponse());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      const coverageEvents = mockClickHouseWrite.mock.calls.filter(
        (c) => c[0] === 'coverage_transitions',
      );
      expect(coverageEvents).toHaveLength(1);
      expect(coverageEvents[0][1]).toMatchObject({
        questionId: Q1_ID,
        oldStatus: 'not_started',
        newStatus: 'partially_covered',
        oldConfidence: null,
        newConfidence: 'medium',
        turnNumber: 1,
        hasSummary: true,
      });
      // PII guard: summary string must not appear in the event payload.
      expect(coverageEvents[0][1]).not.toHaveProperty('summary');
    });

    it('persists flagged items and emits one flagged_items event per persisted item', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(flaggedItemResponse());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      expect(mockPrisma.flaggedItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          interviewId: INTERVIEW_ID,
          sourceTurn: 1,
          description: 'Pending vendor dispute affecting Q3 forecast',
          priority: 'HIGH',
          needsAdminReview: true,
        }),
      });

      const flaggedEvents = mockClickHouseWrite.mock.calls.filter(
        (c) => c[0] === 'flagged_items',
      );
      expect(flaggedEvents).toHaveLength(1);
      expect(flaggedEvents[0][1]).toMatchObject({
        priority: 'high',
        suggestedTagCount: 2,
        descriptionLength: 'Pending vendor dispute affecting Q3 forecast'.length,
      });
      expect(flaggedEvents[0][2]).toMatchObject({ severity: 'WARN' }); // high priority
      // No description text in telemetry
      expect(flaggedEvents[0][1]).not.toHaveProperty('description');
      expect(flaggedEvents[0][1]).not.toHaveProperty('suggestedTags');
    });
  });

  describe('parse failures', () => {
    it('single invalid_json parse failure increments consecutiveParseFailures, emits WARN, persists turn', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(malformedJsonResponse());

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      // Turn still persists — interviewee does not see a failure.
      expect(result.responseId).toBeDefined();
      expect(mockPrisma.interviewResponse.create).toHaveBeenCalled();

      // Parse-failure event emitted
      const parseFailEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'state_parse_failures',
      );
      expect(parseFailEvent).toBeDefined();
      expect(parseFailEvent![1]).toMatchObject({
        parseErrorType: 'invalid_json',
        partialApplied: false,
      });
      expect(parseFailEvent![2]).toMatchObject({ severity: 'WARN' });

      // Consecutive counter advanced
      const stored = JSON.parse(mockSessionStore[INTERVIEW_ID]);
      expect(stored.consecutiveParseFailures).toBe(1);

      // No coverage transitions emitted (coverage untouched)
      const covEvents = mockClickHouseWrite.mock.calls.filter(
        (c) => c[0] === 'coverage_transitions',
      );
      expect(covEvents).toHaveLength(0);
    });

    it('three consecutive parse failures synthesizes a fallback decision with WARN severity', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      // Seed session already at 2 consecutive failures — this turn tips it to 3.
      seedSession(buildV2Session({ consecutiveParseFailures: 2 }));
      const streamingClaude = createMockStreamingClaude(malformedJsonResponse());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      const orchEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'orchestration_decisions',
      );
      expect(orchEvent).toBeDefined();
      expect(orchEvent![1]).toMatchObject({
        decisionType: 'fallback',
        sourceQuestionId: '',
        targetQuestionId: '',
      });
      expect(orchEvent![2]).toMatchObject({ severity: 'WARN' });
    });
  });

  describe('close_interview semantics', () => {
    it('marks interview complete when LLM emits close_interview and criterion is satisfied', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);

      // All required questions satisfied: Q1 fully_covered/high, Q2 skipped
      const satisfied: InterviewSession = buildV2Session({
        coverage: {
          [Q1_ID]: {
            status: 'fully_covered',
            confidence: 'high',
            turnNumbers: [1],
            summary: 'done',
          },
          [Q2_ID]: {
            status: 'skipped',
            confidence: null,
            turnNumbers: [2],
            summary: null,
          },
          [Q3_ID]: {
            status: 'not_started',
            confidence: null,
            turnNumbers: [],
            summary: null,
          },
        },
      });
      seedSession(satisfied);
      const streamingClaude = createMockStreamingClaude(closeInterviewResponse());

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      expect(result.interviewStatus).toBe('completed');
      expect(mockPrisma.interview.update).toHaveBeenCalledWith({
        where: { id: INTERVIEW_ID },
        data: expect.objectContaining({ status: 'completed' }),
      });

      const orchEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'orchestration_decisions',
      );
      expect(orchEvent![1]).toMatchObject({ decisionType: 'close_interview' });
      expect(orchEvent![2]).toMatchObject({ severity: 'INFO' });
    });

    it('demotes close_interview to fallback when criterion is NOT met, keeps interview open', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      // Coverage is not_started for required Q2 — criterion fails
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(closeInterviewResponse());

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      expect(result.interviewStatus).toBe('in_progress');
      // The only interview.update calls should be cost-token increments.
      // There must be NO call that sets `status: 'completed'`.
      const completionCalls = mockPrisma.interview.update.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { data?: { status?: string } };
          return arg?.data?.status === 'completed';
        },
      );
      expect(completionCalls).toHaveLength(0);

      const orchEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'orchestration_decisions',
      );
      expect(orchEvent![1]).toMatchObject({ decisionType: 'fallback' });
      expect(orchEvent![2]).toMatchObject({ severity: 'WARN' });
    });
  });

  describe('partial parse (unknown questionId)', () => {
    it('applies the valid coverage update, emits state_parse_failures with partialApplied=true', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());
      const streamingClaude = createMockStreamingClaude(unknownQuestionIdResponse());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      // The valid Q1 coverage update applied
      const coverageEvents = mockClickHouseWrite.mock.calls.filter(
        (c) => c[0] === 'coverage_transitions',
      );
      expect(coverageEvents).toHaveLength(1);
      expect(coverageEvents[0][1]).toMatchObject({
        questionId: Q1_ID,
        newStatus: 'fully_covered',
        newConfidence: 'high',
      });

      // state_parse_failures event emitted with partialApplied=true
      const parseFailEvent = mockClickHouseWrite.mock.calls.find(
        (c) => c[0] === 'state_parse_failures',
      );
      expect(parseFailEvent).toBeDefined();
      expect(parseFailEvent![1]).toMatchObject({
        parseErrorType: 'unknown_question_id',
        partialApplied: true,
        unknownQuestionIdCount: 1,
      });
    });
  });

  describe('v1-pool dispatch', () => {
    it('routes v1-pool session through legacy path, never invokes streaming client', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV1Session());

      // Spy on the legacy system-prompt builder; legacy path invokes it.
      const legacySpy = vi.spyOn(promptConstructor, 'buildSystemPrompt');

      const legacyClaude = createMockLegacyClaude();
      const streamingClaude = createMockStreamingClaude(happyPathResponse());

      const result = await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: legacyClaude, streamingClaude },
      );

      expect(result.responseId).toBeDefined();
      // Streaming client never called
      expect(streamingClaude.streamCallCount()).toBe(0);
      // Legacy chat client was called
      expect(legacyClaude.chat).toHaveBeenCalled();
      // Legacy prompt constructor was invoked
      expect(legacySpy).toHaveBeenCalled();

      // No v2 emitters fired (orchestration/coverage/flagged/parseFail)
      const v2Events = mockClickHouseWrite.mock.calls.filter((c) =>
        ['orchestration_decisions', 'coverage_transitions', 'flagged_items', 'state_parse_failures']
          .includes(c[0] as string),
      );
      expect(v2Events).toHaveLength(0);

      legacySpy.mockRestore();
    });
  });

  describe('SSE delimiter streaming', () => {
    it('streams only pre-delimiter tokens to the onPreDelimiterToken callback', async () => {
      ({ prisma: mockPrisma, transactionSpy } = createMockPrisma());
      mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
      setupTemplateMocks(mockPrisma);
      seedSession(buildV2Session());

      const streamingClaude = createMockStreamingClaude(happyPathResponse());

      await submitResponse(
        mockPrisma,
        USER_ID,
        defaultSubmitInput(),
        { claude: createMockLegacyClaude(), streamingClaude },
      );

      // All emissions joined should be exactly the pre-delimiter conversational text.
      const emitted = streamingClaude.lastOnTokenEmissions().join('');
      expect(emitted).not.toContain('---STATE_UPDATE---');
      expect(emitted).not.toContain('decisionType');
      expect(emitted.startsWith('That lines up')).toBe(true);
    });

    it('DelimiterBoundaryDetector withholds bytes that might start a delimiter mid-chunk', () => {
      const detector = new DelimiterBoundaryDetector('---STATE_UPDATE---');
      // Feed a token that ends with "---" — a prefix of the delimiter.
      const emit1 = detector.ingest('Hello there---');
      expect(emit1).toBe('Hello there');
      // Now the full delimiter arrives.
      const emit2 = detector.ingest('STATE_UPDATE---');
      // Everything preceding the delimiter ('Hello there' already emitted) — nothing new to emit.
      expect(emit2).toBe('');
      // Subsequent tokens inside the state block do not emit.
      const emit3 = detector.ingest('\n{"decisionType":"probe_deeper"}');
      expect(emit3).toBe('');
    });

    it('DelimiterBoundaryDetector flushes the full content when no delimiter ever appears', () => {
      const detector = new DelimiterBoundaryDetector('---STATE_UPDATE---');
      const parts = ['Short ', 'message ', 'without ', 'any ', 'delimiter.'];
      const emitted: string[] = [];
      for (const p of parts) {
        const e = detector.ingest(p);
        if (e) emitted.push(e);
      }
      const tail = detector.flushIfNoDelimiter();
      if (tail) emitted.push(tail);
      expect(emitted.join('')).toBe('Short message without any delimiter.');
    });
  });

  describe('cache control wiring', () => {
    it('applyCacheBreakpoint splits system at the Tier 1 boundary with ephemeral cache_control', () => {
      const built = {
        system: 'TIER_ONE_BODY---TIER_TWO_BODY',
        messages: [],
        cacheBreakpoint: 'TIER_ONE_BODY'.length,
      };
      const blocks = applyCacheBreakpoint(built);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        type: 'text',
        text: 'TIER_ONE_BODY',
        cache_control: { type: 'ephemeral' },
      });
      expect(blocks[1]).toMatchObject({
        type: 'text',
        text: '---TIER_TWO_BODY',
      });
      expect(blocks[1].cache_control).toBeUndefined();
    });

    it('applyCacheBreakpoint returns a single Tier 1 block when Tier 2 is empty', () => {
      const built = {
        system: 'ONLY_TIER_ONE',
        messages: [],
        cacheBreakpoint: 'ONLY_TIER_ONE'.length,
      };
      const blocks = applyCacheBreakpoint(built);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });
});
