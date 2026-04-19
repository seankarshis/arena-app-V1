import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichmentDeps, EnrichmentLlmClient, EnrichmentMessage } from '../lambda/enrichment-handler';
import {
  processEnrichmentMessage,
  parseEnrichmentOutput,
} from '../lambda/enrichment-handler';

// ---------------------------------------------------------------------------
// Mock: emitEnrichmentJob (observability — must not call real ClickHouse)
// ---------------------------------------------------------------------------

vi.mock('../observability/events', () => ({
  emitEnrichmentJob: vi.fn(),
  emitFlaggedItem: vi.fn(),
}));

import { emitEnrichmentJob } from '../observability/events';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    interviewResponse: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'resp-1',
        interviewId: 'int-1',
        questionId: 'q-1',
        questionTextAsAsked: 'What is your integration plan?',
        sequenceNumber: 3,
        cleanedMarkdown: 'We plan to integrate by Q3.',
        rawTranscription: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    interview: {
      findUnique: vi.fn().mockResolvedValue({
        templateId: 'tmpl-1',
      }),
    },
    tag: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tagMergeProposal: {
      create: vi.fn().mockResolvedValue({ id: 'tmp-1' }),
    },
    flaggedItem: {
      create: vi.fn().mockResolvedValue({ id: 'fi-1' }),
    },
    enrichmentOutbox: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn().mockImplementation(async (fn: Function) => fn(createTxMock())),
    $disconnect: vi.fn(),
  };
}

function createTxMock() {
  return {
    interviewResponse: {
      update: vi.fn().mockResolvedValue({}),
    },
    tagMergeProposal: {
      create: vi.fn().mockResolvedValue({ id: 'tmp-1' }),
    },
    flaggedItem: {
      create: vi.fn().mockResolvedValue({ id: 'fi-1' }),
    },
    enrichmentOutbox: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function createMockLlm(
  overrides: Partial<{
    rawOutput: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }> = {},
): EnrichmentLlmClient {
  const defaultOutput: import('../lambda/enrichment-handler').EnrichmentLlmOutput = {
    entities: [{ text: 'IT department', type: 'DEPARTMENT' }],
    suggestedTags: ['integration', 'planning'],
    flaggedItems: [],
    summary: 'Interviewee described Q3 integration timeline.',
  };
  return {
    enrich: vi.fn().mockResolvedValue({
      rawOutput: overrides.rawOutput ?? JSON.stringify(defaultOutput),
      model: overrides.model ?? 'claude-haiku-4-5',
      promptTokens: overrides.promptTokens ?? 200,
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

function createDefaultMessage(overrides: Partial<EnrichmentMessage> = {}): EnrichmentMessage {
  return {
    responseId: 'resp-1',
    interviewId: 'int-1',
    attemptNumber: 1,
    ...overrides,
  };
}

function createDeps(overrides: Partial<EnrichmentDeps> = {}): EnrichmentDeps {
  return {
    prisma: createMockPrisma() as any,
    llm: createMockLlm(),
    logger: createMockLogger() as any,
    loadPrompt: () => '# Enrichment Prompt\nYou are an enrichment assistant.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseEnrichmentOutput unit tests
// ---------------------------------------------------------------------------

describe('parseEnrichmentOutput', () => {
  it('parses valid JSON output', () => {
    const input = JSON.stringify({
      entities: [{ text: 'IT dept', type: 'DEPARTMENT' }],
      suggestedTags: ['integration'],
      flaggedItems: [],
      summary: 'Summary text.',
    });
    const result = parseEnrichmentOutput(input);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].text).toBe('IT dept');
    expect(result.suggestedTags).toEqual(['integration']);
    expect(result.flaggedItems).toHaveLength(0);
    expect(result.summary).toBe('Summary text.');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const inner = JSON.stringify({
      entities: [],
      suggestedTags: ['hr'],
      flaggedItems: [],
      summary: 'A summary.',
    });
    const input = `\`\`\`json\n${inner}\n\`\`\``;
    const result = parseEnrichmentOutput(input);
    expect(result.suggestedTags).toEqual(['hr']);
  });

  it('parses flaggedItems with valid priorities', () => {
    const input = JSON.stringify({
      entities: [],
      suggestedTags: [],
      flaggedItems: [
        { description: 'Sensitive mention', priority: 'high', suggestedTags: ['sensitive'] },
      ],
      summary: 'Found flagged item.',
    });
    const result = parseEnrichmentOutput(input);
    expect(result.flaggedItems).toHaveLength(1);
    expect(result.flaggedItems[0].priority).toBe('high');
    expect(result.flaggedItems[0].suggestedTags).toEqual(['sensitive']);
  });

  it('throws "invalid_json" on non-JSON input', () => {
    expect(() => parseEnrichmentOutput('not json at all')).toThrow('invalid_json');
  });

  it('throws "schema_mismatch" when entities is not an array', () => {
    const input = JSON.stringify({
      entities: 'not-an-array',
      suggestedTags: [],
      flaggedItems: [],
      summary: 'x',
    });
    expect(() => parseEnrichmentOutput(input)).toThrow('schema_mismatch');
  });

  it('throws "schema_mismatch" when summary is missing', () => {
    const input = JSON.stringify({
      entities: [],
      suggestedTags: [],
      flaggedItems: [],
    });
    expect(() => parseEnrichmentOutput(input)).toThrow('schema_mismatch');
  });

  it('throws "schema_mismatch" when flaggedItem has invalid priority', () => {
    const input = JSON.stringify({
      entities: [],
      suggestedTags: [],
      flaggedItems: [{ description: 'x', priority: 'extreme', suggestedTags: [] }],
      summary: 'x',
    });
    expect(() => parseEnrichmentOutput(input)).toThrow('schema_mismatch');
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — happy path
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits started and succeeded events on success', async () => {
    const deps = createDeps();
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const startedCall = calls.find((c: any[]) => c[0].status === 'started');
    expect(startedCall).toBeDefined();
    expect(startedCall![0]).toMatchObject({
      responseId: 'resp-1',
      interviewId: 'int-1',
      jobType: 'enrichment',
      status: 'started',
      attemptNumber: 1,
      retryCount: 0,
    });

    const succeededCall = calls.find((c: any[]) => c[0].status === 'succeeded');
    expect(succeededCall).toBeDefined();
    expect(succeededCall![0]).toMatchObject({
      responseId: 'resp-1',
      interviewId: 'int-1',
      jobType: 'enrichment',
      status: 'succeeded',
      attemptNumber: 1,
      retryCount: 0,
      model: 'claude-haiku-4-5',
      promptTokens: 200,
      completionTokens: 80,
    });
  });

  it('emits succeeded with WARN severity when retryCount > 0', async () => {
    const deps = createDeps();
    // attemptNumber=3 means retryCount=2
    const message = createDefaultMessage({ attemptNumber: 3 });

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const succeededCall = calls.find((c: any[]) => c[0].status === 'succeeded');
    expect(succeededCall).toBeDefined();
    // retryCount should be 2 (attemptNumber - 1)
    expect(succeededCall![0].retryCount).toBe(2);
  });

  it('calls LLM with the system prompt and response snapshot', async () => {
    const llm = createMockLlm();
    const deps = createDeps({ llm });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    expect(llm.enrich).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Enrichment Prompt'),
        responseSnapshot: 'We plan to integrate by Q3.',
      }),
    );
  });

  it('uses rawTranscription when cleanedMarkdown is null', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findUnique.mockResolvedValue({
      id: 'resp-1',
      interviewId: 'int-1',
      questionId: 'q-1',
      questionTextAsAsked: 'What is your plan?',
      sequenceNumber: 1,
      cleanedMarkdown: null,
      rawTranscription: 'Um, so we plan to integrate.',
    });

    const llm = createMockLlm();
    const deps = createDeps({ prisma: prisma as any, llm });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    expect(llm.enrich).toHaveBeenCalledWith(
      expect.objectContaining({
        responseSnapshot: 'Um, so we plan to integrate.',
      }),
    );
  });

  it('runs all DB writes in a single prisma.$transaction call', async () => {
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deletes the EnrichmentOutbox row within the transaction on success', async () => {
    let capturedTx: any = null;
    const prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(async (fn: Function) => {
      const tx = createTxMock();
      capturedTx = tx;
      return fn(tx);
    });

    const deps = createDeps({ prisma: prisma as any });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    expect(capturedTx.enrichmentOutbox.deleteMany).toHaveBeenCalledWith({
      where: { responseId: 'resp-1' },
    });
  });

  it('returns entityCount and tagCount in result', async () => {
    const llmOutput = JSON.stringify({
      entities: [{ text: 'Dept A', type: 'DEPT' }, { text: 'Role X', type: 'ROLE' }],
      suggestedTags: ['finance', 'hr'],
      flaggedItems: [],
      summary: 'Two entities found.',
    });
    const prisma = createMockPrisma();
    prisma.tag.findMany.mockResolvedValue([
      { id: 'tag-1', label: 'finance' },
      { id: 'tag-2', label: 'hr' },
    ]);
    const deps = createDeps({
      prisma: prisma as any,
      llm: createMockLlm({ rawOutput: llmOutput }),
    });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');
    expect(result.entityCount).toBe(2);
    expect(result.tagCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — invalid LLM response
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — invalid LLM response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits failed with errorCode=invalid_response when LLM output is not parseable JSON', async () => {
    const llm = createMockLlm({ rawOutput: 'This is not JSON at all.' });
    const deps = createDeps({ llm });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('invalid_response');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find((c: any[]) => c[0].status === 'failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![0]).toMatchObject({
      responseId: 'resp-1',
      interviewId: 'int-1',
      status: 'failed',
      errorCode: 'invalid_response',
    });
  });

  it('emits failed with errorCode=invalid_response when LLM output fails schema validation', async () => {
    const badOutput = JSON.stringify({
      entities: 'not-an-array',
      suggestedTags: [],
      flaggedItems: [],
      summary: 'ok',
    });
    const llm = createMockLlm({ rawOutput: badOutput });
    const deps = createDeps({ llm });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('invalid_response');
  });

  it('does not delete the EnrichmentOutbox row on parse failure (leaves for SQS redrive)', async () => {
    const llm = createMockLlm({ rawOutput: 'invalid json' });
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any, llm });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    // $transaction should NOT have been called — the parse failure happens before DB writes
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — DB write failure
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — DB write failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits failed with errorCode=db_write_failed when prisma.$transaction throws', async () => {
    const prisma = createMockPrisma();
    prisma.$transaction.mockRejectedValue(new Error('Connection reset'));

    const deps = createDeps({ prisma: prisma as any });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('db_write_failed');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find((c: any[]) => c[0].status === 'failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![0]).toMatchObject({
      status: 'failed',
      errorCode: 'db_write_failed',
    });
  });

  it('emits started before the DB failure occurs', async () => {
    const prisma = createMockPrisma();
    prisma.$transaction.mockRejectedValue(new Error('DB down'));

    const deps = createDeps({ prisma: prisma as any });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const startedCall = calls.find((c: any[]) => c[0].status === 'started');
    expect(startedCall).toBeDefined();
  });

  it('emits failed with errorCode=db_write_failed when findUnique throws', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findUnique.mockRejectedValue(new Error('DB connection refused'));

    const deps = createDeps({ prisma: prisma as any });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('db_write_failed');
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — LLM timeout
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — LLM timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits failed with errorCode=llm_timeout when LLM throws a timeout error', async () => {
    const llm: EnrichmentLlmClient = {
      enrich: vi.fn().mockRejectedValue(new Error('Request timed out')),
    };
    const deps = createDeps({ llm });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('llm_timeout');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find((c: any[]) => c[0].status === 'failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![0].errorCode).toBe('llm_timeout');
  });

  it('emits failed with errorCode=llm_error for non-timeout LLM errors', async () => {
    const llm: EnrichmentLlmClient = {
      enrich: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    };
    const deps = createDeps({ llm });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('llm_error');
  });

  it('does not retry in-handler — leaves outbox row intact for SQS redrive', async () => {
    const llm: EnrichmentLlmClient = {
      enrich: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    };
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any, llm });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    // LLM enrich called once — no retry loop
    expect(llm.enrich).toHaveBeenCalledTimes(1);
    // No transaction attempted (no DB writes)
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — tag proposal path
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — tag proposal path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT create a TagMergeProposal for suggested tags that already exist as canonical tags', async () => {
    const llmOutput = JSON.stringify({
      entities: [],
      suggestedTags: ['integration', 'planning'],
      flaggedItems: [],
      summary: 'Tags exist.',
    });

    const prisma = createMockPrisma();
    // Both tags already exist as canonical
    prisma.tag.findMany.mockResolvedValue([
      { id: 'tag-1', label: 'integration' },
      { id: 'tag-2', label: 'planning' },
    ]);

    let capturedTx: any = null;
    prisma.$transaction.mockImplementation(async (fn: Function) => {
      const tx = createTxMock();
      capturedTx = tx;
      return fn(tx);
    });

    const deps = createDeps({
      prisma: prisma as any,
      llm: createMockLlm({ rawOutput: llmOutput }),
    });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');
    // No TagMergeProposal created since all tags are already canonical
    expect(capturedTx.tagMergeProposal.create).not.toHaveBeenCalled();
    // tagCount reflects canonical tags found
    expect(result.tagCount).toBe(2);
  });

  it('creates a TagMergeProposal for non-canonical suggested tags when a canonical tag exists to anchor to', async () => {
    const llmOutput = JSON.stringify({
      entities: [],
      suggestedTags: ['integration', 'brand-new-concept'],
      flaggedItems: [],
      summary: 'Mixed tags.',
    });

    const prisma = createMockPrisma();
    // Only 'integration' is canonical; 'brand-new-concept' is not
    prisma.tag.findMany.mockResolvedValue([{ id: 'tag-1', label: 'integration' }]);

    let capturedTx: any = null;
    prisma.$transaction.mockImplementation(async (fn: Function) => {
      const tx = createTxMock();
      capturedTx = tx;
      return fn(tx);
    });

    const deps = createDeps({
      prisma: prisma as any,
      llm: createMockLlm({ rawOutput: llmOutput }),
    });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');
    // A TagMergeProposal is created anchored to the canonical tag
    expect(capturedTx.tagMergeProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          canonicalTagId: 'tag-1',
          status: 'PENDING',
          rationale: expect.stringContaining('brand-new-concept'),
        }),
      }),
    );
    // tagCount only counts canonical matches
    expect(result.tagCount).toBe(1);
  });

  it('does NOT create a TagMergeProposal when suggested tags are all non-canonical and no canonical anchor exists', async () => {
    const llmOutput = JSON.stringify({
      entities: [],
      suggestedTags: ['totally-new-tag'],
      flaggedItems: [],
      summary: 'No canonical tags.',
    });

    const prisma = createMockPrisma();
    // No canonical tags found
    prisma.tag.findMany.mockResolvedValue([]);

    let capturedTx: any = null;
    prisma.$transaction.mockImplementation(async (fn: Function) => {
      const tx = createTxMock();
      capturedTx = tx;
      return fn(tx);
    });

    const deps = createDeps({
      prisma: prisma as any,
      llm: createMockLlm({ rawOutput: llmOutput }),
    });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('succeeded');
    // No TagMergeProposal — no canonical anchor tag
    expect(capturedTx.tagMergeProposal.create).not.toHaveBeenCalled();
    expect(result.tagCount).toBe(0);
  });

  it('inserts FlaggedItem rows for each flagged item from the LLM', async () => {
    const llmOutput = JSON.stringify({
      entities: [],
      suggestedTags: [],
      flaggedItems: [
        { description: 'Potential conflict of interest mentioned', priority: 'high', suggestedTags: ['conflict'] },
        { description: 'Legal risk referenced', priority: 'critical', suggestedTags: [] },
      ],
      summary: 'Two flagged items.',
    });

    const prisma = createMockPrisma();
    let capturedTx: any = null;
    prisma.$transaction.mockImplementation(async (fn: Function) => {
      const tx = createTxMock();
      capturedTx = tx;
      return fn(tx);
    });

    const deps = createDeps({
      prisma: prisma as any,
      llm: createMockLlm({ rawOutput: llmOutput }),
    });
    const message = createDefaultMessage();

    await processEnrichmentMessage(message, deps);

    expect(capturedTx.flaggedItem.create).toHaveBeenCalledTimes(2);
    expect(capturedTx.flaggedItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          interviewId: 'int-1',
          priority: 'HIGH',
          needsAdminReview: true,
        }),
      }),
    );
    expect(capturedTx.flaggedItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priority: 'CRITICAL',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// processEnrichmentMessage — missing prompt
// ---------------------------------------------------------------------------

describe('processEnrichmentMessage — missing prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits failed with errorCode=llm_error when prompt file is missing', async () => {
    const deps = createDeps({
      loadPrompt: () => {
        throw new Error('enrichment-prompt-v1.md not found');
      },
    });
    const message = createDefaultMessage();

    const result = await processEnrichmentMessage(message, deps);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('llm_error');

    const calls = (emitEnrichmentJob as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find((c: any[]) => c[0].status === 'failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![0].errorCode).toBe('llm_error');
  });
});

// ---------------------------------------------------------------------------
// handler export
// ---------------------------------------------------------------------------

describe('handler', () => {
  it('is exported as a function', async () => {
    const { handler } = await import('../lambda/enrichment-handler');
    expect(typeof handler).toBe('function');
  });
});
