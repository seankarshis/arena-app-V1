import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReconciliationDeps } from '../lambda/reconciliation-handler';
import {
  scanStuckCleaning,
  scanAudioInconsistencies,
  scanPausedInterviews,
  runReconciliation,
} from '../lambda/reconciliation-handler';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    interviewResponse: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    interview: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    $disconnect: vi.fn(),
  };
}

function createMockRedis() {
  return {
    scan: vi.fn().mockResolvedValue(['0', []]),
    hgetall: vi.fn().mockResolvedValue({}),
    hset: vi.fn().mockResolvedValue('OK'),
    hdel: vi.fn().mockResolvedValue(1),
    quit: vi.fn(),
  };
}

function createMockEventBridge() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function createMockS3() {
  return { listAudioKeys: vi.fn().mockResolvedValue([]) };
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
  overrides: Partial<Record<keyof ReconciliationDeps, unknown>> = {},
): ReconciliationDeps {
  return {
    prisma: createMockPrisma() as any,
    redis: createMockRedis() as any,
    eventBridge: createMockEventBridge(),
    s3: createMockS3(),
    logger: createMockLogger() as any,
    ...overrides,
  } as ReconciliationDeps;
}

// ---------------------------------------------------------------------------
// Scan 1: Stuck Cleaning States and Turn Locks
// ---------------------------------------------------------------------------

describe('scanStuckCleaning', () => {
  it('returns clean result when no stuck responses exist', async () => {
    const deps = createDeps();
    const result = await scanStuckCleaning(deps);

    expect(result.scan).toBe('stuck_cleaning');
    expect(result.processed).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('resets stuck cleaning responses to pending', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue([
      { id: 'resp-1' },
      { id: 'resp-2' },
    ]);
    prisma.interviewResponse.updateMany.mockResolvedValue({ count: 2 });

    const deps = createDeps({ prisma: prisma as any });
    const result = await scanStuckCleaning(deps);

    expect(prisma.interviewResponse.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['resp-1', 'resp-2'] } },
      data: { processingStatus: 'pending' },
    });
    expect(result.processed).toBe(2);
  });

  it('emits STUCK_CLEANING_BATCH alert when >10 records stuck', async () => {
    const stuckRecords = Array.from({ length: 12 }, (_, i) => ({
      id: `resp-${i}`,
    }));
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue(stuckRecords);
    prisma.interviewResponse.updateMany.mockResolvedValue({ count: 12 });

    const deps = createDeps({ prisma: prisma as any });
    const result = await scanStuckCleaning(deps);

    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: 'STUCK_CLEANING_BATCH',
        severity: 'warning',
      }),
    );
  });

  it('does NOT emit STUCK_CLEANING_BATCH when <=10 records stuck', async () => {
    const stuckRecords = Array.from({ length: 5 }, (_, i) => ({
      id: `resp-${i}`,
    }));
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockResolvedValue(stuckRecords);
    prisma.interviewResponse.updateMany.mockResolvedValue({ count: 5 });

    const deps = createDeps({ prisma: prisma as any });
    const result = await scanStuckCleaning(deps);

    expect(
      result.alerts.find((a) => a.code === 'STUCK_CLEANING_BATCH'),
    ).toBeUndefined();
  });

  it('queries responses with processingStatus=cleaning and respondedAt >10min ago', async () => {
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any });

    const before = Date.now();
    await scanStuckCleaning(deps);

    const call = prisma.interviewResponse.findMany.mock.calls[0][0];
    expect(call.where.processingStatus).toBe('cleaning');
    const threshold = call.where.respondedAt.lt as Date;
    // Threshold should be ~10 minutes ago (allow 5s tolerance)
    expect(before - threshold.getTime()).toBeGreaterThanOrEqual(10 * 60 * 1000 - 5000);
    expect(before - threshold.getTime()).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
  });

  it('resets stuck Redis turn locks older than 60s', async () => {
    const redis = createMockRedis();
    redis.scan.mockResolvedValue(['0', ['interview:session:abc-123']]);
    redis.hgetall.mockResolvedValue({
      is_streaming: 'true',
      streaming_started_at: String(Date.now() - 120_000), // 2 minutes ago
    });

    const deps = createDeps({ redis: redis as any });
    const result = await scanStuckCleaning(deps);

    expect(redis.hset).toHaveBeenCalledWith(
      'interview:session:abc-123',
      'is_streaming',
      'false',
    );
    expect(redis.hdel).toHaveBeenCalledWith(
      'interview:session:abc-123',
      'current_turn_llm_text',
    );
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: 'TURN_LOCK_STUCK',
        severity: 'warning',
        metadata: { interviewId: 'abc-123' },
      }),
    );
    expect(result.processed).toBeGreaterThanOrEqual(1);
  });

  it('does not reset Redis turn locks that are under 60s old', async () => {
    const redis = createMockRedis();
    redis.scan.mockResolvedValue(['0', ['interview:session:abc-123']]);
    redis.hgetall.mockResolvedValue({
      is_streaming: 'true',
      streaming_started_at: String(Date.now() - 30_000), // 30 seconds ago
    });

    const deps = createDeps({ redis: redis as any });
    const result = await scanStuckCleaning(deps);

    expect(redis.hset).not.toHaveBeenCalled();
    expect(redis.hdel).not.toHaveBeenCalled();
    expect(result.alerts.find((a) => a.code === 'TURN_LOCK_STUCK')).toBeUndefined();
  });

  it('skips Redis keys where is_streaming is not true', async () => {
    const redis = createMockRedis();
    redis.scan.mockResolvedValue(['0', ['interview:session:abc-123']]);
    redis.hgetall.mockResolvedValue({
      is_streaming: 'false',
      streaming_started_at: String(Date.now() - 120_000),
    });

    const deps = createDeps({ redis: redis as any });
    await scanStuckCleaning(deps);

    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('paginates through Redis SCAN cursor', async () => {
    const redis = createMockRedis();
    // First scan returns cursor "42" (more keys to scan), second returns "0" (done)
    redis.scan
      .mockResolvedValueOnce(['42', ['interview:session:aaa']])
      .mockResolvedValueOnce(['0', ['interview:session:bbb']]);
    redis.hgetall.mockResolvedValue({
      is_streaming: 'true',
      streaming_started_at: String(Date.now() - 120_000),
    });

    const deps = createDeps({ redis: redis as any });
    const result = await scanStuckCleaning(deps);

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(result.alerts.filter((a) => a.code === 'TURN_LOCK_STUCK')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scan 2: Audio Upload Inconsistencies
// ---------------------------------------------------------------------------

describe('scanAudioInconsistencies', () => {
  it('returns clean result when no audio issues exist', async () => {
    const deps = createDeps();
    const result = await scanAudioInconsistencies(deps);

    expect(result.scan).toBe('audio_inconsistencies');
    expect(result.processed).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('flags pending voice audio uploads older than 1 hour', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany
      .mockResolvedValueOnce([
        { id: 'resp-1', interviewId: 'int-1' },
        { id: 'resp-2', interviewId: 'int-2' },
      ]) // Query A: pending
      .mockResolvedValueOnce([]) // Query B: failed
      .mockResolvedValue([]); // Query C: S3 match

    const logger = createMockLogger();
    const deps = createDeps({ prisma: prisma as any, logger: logger as any });
    const result = await scanAudioInconsistencies(deps);

    expect(result.processed).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining('pending audio uploads'),
    );
  });

  it('queries pending audio with correct filters', async () => {
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any });

    const before = Date.now();
    await scanAudioInconsistencies(deps);

    const call = prisma.interviewResponse.findMany.mock.calls[0][0];
    expect(call.where.inputMode).toBe('voice');
    expect(call.where.audioUploadStatus).toBe('pending');
    const threshold = call.where.respondedAt.lt as Date;
    expect(before - threshold.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
    expect(before - threshold.getTime()).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });

  it('logs failed audio uploads', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany
      .mockResolvedValueOnce([]) // Query A
      .mockResolvedValueOnce([
        { id: 'resp-1', interviewId: 'int-1' },
        { id: 'resp-2', interviewId: 'int-2' },
      ]) // Query B: failed
      .mockResolvedValue([]);

    const logger = createMockLogger();
    const deps = createDeps({ prisma: prisma as any, logger: logger as any });
    const result = await scanAudioInconsistencies(deps);

    expect(result.processed).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining('failed audio uploads'),
    );
  });

  it('emits AUDIO_UPLOAD_FAILURE_BATCH when >5 failed uploads', async () => {
    const failedRecords = Array.from({ length: 7 }, (_, i) => ({
      id: `resp-${i}`,
      interviewId: `int-${i}`,
    }));
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany
      .mockResolvedValueOnce([]) // Query A
      .mockResolvedValueOnce(failedRecords) // Query B
      .mockResolvedValue([]);

    const deps = createDeps({ prisma: prisma as any });
    const result = await scanAudioInconsistencies(deps);

    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: 'AUDIO_UPLOAD_FAILURE_BATCH',
        severity: 'warning',
        metadata: { count: 7 },
      }),
    );
  });

  it('does NOT emit AUDIO_UPLOAD_FAILURE_BATCH when <=5 failed', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany
      .mockResolvedValueOnce([]) // Query A
      .mockResolvedValueOnce([{ id: 'resp-1', interviewId: 'int-1' }]) // Query B: 1 failed
      .mockResolvedValue([]);

    const deps = createDeps({ prisma: prisma as any });
    const result = await scanAudioInconsistencies(deps);

    expect(
      result.alerts.find((a) => a.code === 'AUDIO_UPLOAD_FAILURE_BATCH'),
    ).toBeUndefined();
  });

  it('detects orphaned S3 objects when S3_AUDIO_BUCKET is set', async () => {
    const originalEnv = process.env.S3_AUDIO_BUCKET;
    process.env.S3_AUDIO_BUCKET = 'test-bucket';

    try {
      const prisma = createMockPrisma();
      prisma.interviewResponse.findMany
        .mockResolvedValueOnce([]) // Query A
        .mockResolvedValueOnce([]) // Query B
        .mockResolvedValueOnce([{ s3AudioKey: 'responses/key-1.webm' }]); // Query C: DB match

      const s3 = createMockS3();
      s3.listAudioKeys.mockResolvedValue([
        'responses/key-1.webm',
        'responses/key-2.webm',
        'responses/orphan.webm',
      ]);

      const logger = createMockLogger();
      const deps = createDeps({
        prisma: prisma as any,
        s3,
        logger: logger as any,
      });
      const result = await scanAudioInconsistencies(deps);

      expect(s3.listAudioKeys).toHaveBeenCalledWith('responses/');
      // 2 orphaned keys (key-2 and orphan are not in DB match set)
      expect(result.processed).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ count: 2 }),
        expect.stringContaining('orphaned S3'),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.S3_AUDIO_BUCKET;
      } else {
        process.env.S3_AUDIO_BUCKET = originalEnv;
      }
    }
  });

  it('skips S3 orphan check when S3_AUDIO_BUCKET is not set', async () => {
    const originalEnv = process.env.S3_AUDIO_BUCKET;
    delete process.env.S3_AUDIO_BUCKET;

    try {
      const s3 = createMockS3();
      const deps = createDeps({ s3 });
      await scanAudioInconsistencies(deps);

      expect(s3.listAudioKeys).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) {
        process.env.S3_AUDIO_BUCKET = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scan 3: Paused Interview Auto-Abandonment
// ---------------------------------------------------------------------------

describe('scanPausedInterviews', () => {
  it('returns clean result when no stale paused interviews exist', async () => {
    const deps = createDeps();
    const result = await scanPausedInterviews(deps);

    expect(result.scan).toBe('paused_abandonment');
    expect(result.processed).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('abandons paused interviews older than 72 hours', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findMany.mockResolvedValue([
      { id: 'int-1', userId: 'user-1', templateId: 'tmpl-1' },
    ]);

    const eventBridge = createMockEventBridge();
    const deps = createDeps({
      prisma: prisma as any,
      eventBridge,
    });
    const result = await scanPausedInterviews(deps);

    expect(prisma.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { status: 'abandoned' },
    });
    expect(result.processed).toBe(1);
  });

  it('queries paused interviews with pausedAt >72hrs ago', async () => {
    const prisma = createMockPrisma();
    const deps = createDeps({ prisma: prisma as any });

    const before = Date.now();
    await scanPausedInterviews(deps);

    const call = prisma.interview.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('paused');
    const threshold = call.where.pausedAt.lt as Date;
    const expected72hrs = 72 * 60 * 60 * 1000;
    expect(before - threshold.getTime()).toBeGreaterThanOrEqual(expected72hrs - 5000);
    expect(before - threshold.getTime()).toBeLessThanOrEqual(expected72hrs + 5000);
  });

  it('publishes interview.abandoned EventBridge event', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findMany.mockResolvedValue([
      { id: 'int-1', userId: 'user-1', templateId: 'tmpl-1' },
    ]);

    const eventBridge = createMockEventBridge();
    const deps = createDeps({
      prisma: prisma as any,
      eventBridge,
    });
    await scanPausedInterviews(deps);

    expect(eventBridge.publish).toHaveBeenCalledWith({
      source: 'arena.reconciliation',
      detailType: 'interview.abandoned',
      detail: JSON.stringify({
        interviewId: 'int-1',
        userId: 'user-1',
        templateId: 'tmpl-1',
        reason: 'auto_abandoned_paused_timeout',
      }),
    });
  });

  it('emits INTERVIEW_ABANDONED_AUTO alert for each abandoned interview', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findMany.mockResolvedValue([
      { id: 'int-1', userId: 'user-1', templateId: 'tmpl-1' },
      { id: 'int-2', userId: 'user-2', templateId: 'tmpl-2' },
    ]);

    const eventBridge = createMockEventBridge();
    const deps = createDeps({
      prisma: prisma as any,
      eventBridge,
    });
    const result = await scanPausedInterviews(deps);

    expect(result.processed).toBe(2);
    expect(result.alerts).toHaveLength(2);
    expect(result.alerts[0]).toMatchObject({
      code: 'INTERVIEW_ABANDONED_AUTO',
      severity: 'info',
      metadata: { interviewId: 'int-1' },
    });
    expect(result.alerts[1]).toMatchObject({
      code: 'INTERVIEW_ABANDONED_AUTO',
      severity: 'info',
      metadata: { interviewId: 'int-2' },
    });
  });
});

// ---------------------------------------------------------------------------
// runReconciliation — orchestrator
// ---------------------------------------------------------------------------

describe('runReconciliation', () => {
  it('runs all three scans and returns aggregated results', async () => {
    const deps = createDeps();
    const results = await runReconciliation(deps);

    expect(results).toHaveLength(3);
    expect(results[0].scan).toBe('stuck_cleaning');
    expect(results[1].scan).toBe('audio_inconsistencies');
    expect(results[2].scan).toBe('paused_abandonment');
  });

  it('propagates errors from individual scans', async () => {
    const prisma = createMockPrisma();
    prisma.interviewResponse.findMany.mockRejectedValue(
      new Error('DB connection failed'),
    );

    const deps = createDeps({ prisma: prisma as any });

    await expect(runReconciliation(deps)).rejects.toThrow(
      'DB connection failed',
    );
  });
});

// ---------------------------------------------------------------------------
// Handler — error handling
// ---------------------------------------------------------------------------

describe('handler', () => {
  it('is exported as a function', async () => {
    const { handler } = await import('../lambda/reconciliation-handler');
    expect(typeof handler).toBe('function');
  });
});
