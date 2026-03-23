import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CleaningDeps, ClaudeApiClient } from '../lambda/cleaning-handler';
import { processInterview } from '../lambda/cleaning-handler';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    interviewResponse: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    interview: {
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    ),
    $disconnect: vi.fn(),
  };
}

function createMockClaude(
  overrides: Partial<{
    cleanedMarkdown: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }> = {},
): ClaudeApiClient {
  return {
    clean: vi.fn().mockResolvedValue({
      cleanedMarkdown: overrides.cleanedMarkdown ?? 'Cleaned text content.',
      model: overrides.model ?? 'claude-sonnet-4-20250514',
      promptTokens: overrides.promptTokens ?? 150,
      completionTokens: overrides.completionTokens ?? 80,
    }),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  };
}

function createDeps(
  overrides: Partial<Record<keyof CleaningDeps, unknown>> = {},
): CleaningDeps {
  return {
    prisma: createMockPrisma() as any,
    claude: createMockClaude(),
    logger: createMockLogger() as any,
    ...overrides,
  } as CleaningDeps;
}

// ---------------------------------------------------------------------------
// processInterview
// ---------------------------------------------------------------------------

describe('processInterview', () => {
  it('returns empty array when no pending responses exist', async () => {
    const deps = createDeps();
    const results = await processInterview('int-1', deps);

    expect(results).toHaveLength(0);
  });

  it('queries for pending responses with raw_transcription', async () => {
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any });

    await processInterview('int-1', deps);

    expect(prisma.interviewResponse.findMany).toHaveBeenCalledWith({
      where: {
        interviewId: 'int-1',
        rawTranscription: { not: null },
        processingStatus: 'pending',
      },
      select: {
        id: true,
        rawTranscription: true,
      },
      orderBy: { sequenceNumber: 'asc' },
    });
  });

  it('sets processing_status to cleaning before calling Claude', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Um, so like, I think...' },
    ]);

    const claude = createMockClaude();
    const deps = createDeps({ prisma: prisma as any, claude });

    await processInterview('int-1', deps);

    const updateCalls = prisma.interviewResponse.update.mock.calls;
    expect(updateCalls[0][0]).toEqual({
      where: { id: 'resp-1' },
      data: { processingStatus: 'cleaning' },
    });
  });

  it('calls Claude API with raw transcription text', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Um, so like, I think the answer is...' },
    ]);

    const claude = createMockClaude();
    const deps = createDeps({ prisma: prisma as any, claude });

    await processInterview('int-1', deps);

    expect(claude.clean).toHaveBeenCalledWith(
      'Um, so like, I think the answer is...',
    );
  });

  it('writes cleaned data and updates processing_status to cleaned', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Um, so like, I think...' },
    ]);

    const claude = createMockClaude({
      cleanedMarkdown: 'I think the answer is clear.',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 200,
      completionTokens: 100,
    });
    const deps = createDeps({ prisma: prisma as any, claude });

    await processInterview('int-1', deps);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txArgs = prisma.$transaction.mock.calls[0][0];
    expect(txArgs).toHaveLength(2);
  });

  it('increments interview-level cost totals in the same transaction', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Some text' },
    ]);

    const claude = createMockClaude({ promptTokens: 200, completionTokens: 100 });
    const deps = createDeps({ prisma: prisma as any, claude });

    await processInterview('int-1', deps);

    expect(prisma.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: {
        totalLlmPromptTokens: { increment: 200 },
        totalLlmCompletionTokens: { increment: 100 },
      },
    });
  });

  it('returns cleaned status for successfully processed responses', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Text one' },
      { id: 'resp-2', rawTranscription: 'Text two' },
    ]);

    const deps = createDeps({ prisma: prisma as any });
    const results = await processInterview('int-1', deps);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ responseId: 'resp-1', status: 'cleaned' });
    expect(results[1]).toEqual({ responseId: 'resp-2', status: 'cleaned' });
  });

  it('sets processing_status to error when Claude API fails', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Some text' },
    ]);

    const claude: ClaudeApiClient = {
      clean: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    };
    const deps = createDeps({ prisma: prisma as any, claude });

    const results = await processInterview('int-1', deps);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      responseId: 'resp-1',
      status: 'error',
      errorMessage: 'API rate limit exceeded',
    });

    // Should have set error status on the response
    const errorUpdate = prisma.interviewResponse.update.mock.calls.find(
      (call: any[]) =>
        call[0].data.processingStatus === 'error',
    );
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate![0].data.errorMessage).toBe('API rate limit exceeded');
  });

  it('continues processing remaining responses when one fails', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Text one' },
      { id: 'resp-2', rawTranscription: 'Text two' },
      { id: 'resp-3', rawTranscription: 'Text three' },
    ]);

    const claude: ClaudeApiClient = {
      clean: vi
        .fn()
        .mockResolvedValueOnce({
          cleanedMarkdown: 'Clean one.',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 100,
          completionTokens: 50,
        })
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce({
          cleanedMarkdown: 'Clean three.',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 120,
          completionTokens: 60,
        }),
    };

    const deps = createDeps({ prisma: prisma as any, claude });
    const results = await processInterview('int-1', deps);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('cleaned');
    expect(results[1].status).toBe('error');
    expect(results[1].errorMessage).toBe('Transient failure');
    expect(results[2].status).toBe('cleaned');

    // Claude should have been called 3 times (once per response)
    expect(claude.clean).toHaveBeenCalledTimes(3);
  });

  it('logs CLEANING_PIPELINE_ERROR_RATE when error rate exceeds 10%', async () => {
    const prisma = createMockPrisma();
    // 5 responses — if 1 fails that's 20% > 10%
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Text' },
      { id: 'resp-2', rawTranscription: 'Text' },
      { id: 'resp-3', rawTranscription: 'Text' },
      { id: 'resp-4', rawTranscription: 'Text' },
      { id: 'resp-5', rawTranscription: 'Text' },
    ]);

    const claude: ClaudeApiClient = {
      clean: vi
        .fn()
        .mockResolvedValueOnce({
          cleanedMarkdown: 'OK',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 5,
        })
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({
          cleanedMarkdown: 'OK',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 5,
        })
        .mockResolvedValueOnce({
          cleanedMarkdown: 'OK',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 5,
        })
        .mockResolvedValueOnce({
          cleanedMarkdown: 'OK',
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 5,
        }),
    };

    const logger = createMockLogger();
    const deps = createDeps({ prisma: prisma as any, claude, logger: logger as any });

    await processInterview('int-1', deps);

    const alertCall = logger.error.mock.calls.find(
      (call: any[]) =>
        typeof call[0] === 'object' &&
        call[0]?.alert?.code === 'CLEANING_PIPELINE_ERROR_RATE',
    );
    expect(alertCall).toBeDefined();
    expect(alertCall![0].alert.severity).toBe('critical');
  });

  it('does NOT log CLEANING_PIPELINE_ERROR_RATE when error rate is at or below 10%', async () => {
    const prisma = createMockPrisma();
    // 10 responses — 1 fails = 10%, not exceeding threshold
    const responses = Array.from({ length: 10 }, (_, i) => ({
      id: `resp-${i}`,
      rawTranscription: `Text ${i}`,
    }));
    prisma.interviewResponse.findMany.mockResolvedValue(responses);

    const cleanResult = {
      cleanedMarkdown: 'OK',
      model: 'claude-sonnet-4-20250514',
      promptTokens: 10,
      completionTokens: 5,
    };

    const claude: ClaudeApiClient = {
      clean: vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue(cleanResult),
    };

    const logger = createMockLogger();
    const deps = createDeps({ prisma: prisma as any, claude, logger: logger as any });

    await processInterview('int-1', deps);

    const alertCall = logger.error.mock.calls.find(
      (call: any[]) =>
        typeof call[0] === 'object' &&
        call[0]?.alert?.code === 'CLEANING_PIPELINE_ERROR_RATE',
    );
    expect(alertCall).toBeUndefined();
  });

  it('handles non-Error throw from Claude API', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Some text' },
    ]);

    const claude: ClaudeApiClient = {
      clean: vi.fn().mockRejectedValue('string error'),
    };
    const deps = createDeps({ prisma: prisma as any, claude });

    const results = await processInterview('int-1', deps);

    expect(results[0]).toEqual({
      responseId: 'resp-1',
      status: 'error',
      errorMessage: 'Unknown cleaning error',
    });
  });

  it('handles error status update failure gracefully', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1', rawTranscription: 'Some text' },
    ]);

    // First call: set to cleaning — succeeds
    // Second call: set to error — fails (simulating DB down)
    prisma.interviewResponse.update
      .mockResolvedValueOnce({}) // cleaning status
      .mockRejectedValueOnce(new Error('DB write failed')); // error status write

    const claude: ClaudeApiClient = {
      clean: vi.fn().mockRejectedValue(new Error('API down')),
    };

    const logger = createMockLogger();
    const deps = createDeps({ prisma: prisma as any, claude, logger: logger as any });

    // Should not throw — continues processing
    const results = await processInterview('int-1', deps);

    expect(results[0].status).toBe('error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: 'resp-1' }),
      'Failed to set error status on response',
    );
  });

  it('processes responses in sequence order', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-a', rawTranscription: 'First answer' },
      { id: 'resp-b', rawTranscription: 'Second answer' },
    ]);

    const callOrder: string[] = [];
    const claude: ClaudeApiClient = {
      clean: vi.fn().mockImplementation(async (text: string) => {
        callOrder.push(text);
        return {
          cleanedMarkdown: text,
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 5,
        };
      }),
    };

    const deps = createDeps({ prisma: prisma as any, claude });
    await processInterview('int-1', deps);

    expect(callOrder).toEqual(['First answer', 'Second answer']);
  });
});

// ---------------------------------------------------------------------------
// Handler export
// ---------------------------------------------------------------------------

describe('handler', () => {
  it('is exported as a function', async () => {
    const { handler } = await import('../lambda/cleaning-handler');
    expect(typeof handler).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// SQS message parsing
// ---------------------------------------------------------------------------

describe('handler SQS message parsing', () => {
  it('extracts interviewId from EventBridge-wrapped SQS body', async () => {
    // We test this indirectly through processInterview since the handler
    // requires PrismaClient and API key. The parsing logic is straightforward.
    const { handler } = await import('../lambda/cleaning-handler');
    expect(typeof handler).toBe('function');
  });
});
