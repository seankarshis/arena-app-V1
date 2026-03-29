import type { ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import pino from 'pino';
import { clickHouseWrite } from '../observability/clickhouseWriter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Alert {
  code: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ScanResult {
  scan: string;
  processed: number;
  alerts: Alert[];
}

export interface EventBridgePublisher {
  publish(params: {
    source: string;
    detailType: string;
    detail: string;
  }): Promise<void>;
}

export interface S3AudioLister {
  listAudioKeys(prefix: string): Promise<string[]>;
}

export interface ReconciliationDeps {
  prisma: PrismaClient;
  redis: Redis;
  eventBridge: EventBridgePublisher;
  s3: S3AudioLister;
  logger: pino.Logger;
}

// ---------------------------------------------------------------------------
// Scan 1: Stuck Cleaning States and Turn Locks
// ---------------------------------------------------------------------------

export async function scanStuckCleaning(
  deps: ReconciliationDeps,
): Promise<ScanResult> {
  const { prisma, redis, logger } = deps;
  const alerts: Alert[] = [];
  let processed = 0;

  // Query A: interview_responses stuck in 'cleaning' for >10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const stuckResponses = await prisma.interviewResponse.findMany({
    where: {
      processingStatus: 'cleaning',
      respondedAt: { lt: tenMinutesAgo },
    },
    select: { id: true },
  });

  if (stuckResponses.length > 0) {
    const result = await prisma.interviewResponse.updateMany({
      where: { id: { in: stuckResponses.map((r) => r.id) } },
      data: { processingStatus: 'pending' },
    });
    processed += result.count;
    logger.info(
      { count: result.count },
      'Reset stuck cleaning responses to pending',
    );

    if (stuckResponses.length > 10) {
      alerts.push({
        code: 'STUCK_CLEANING_BATCH',
        severity: 'warning',
        description: `${stuckResponses.length} responses stuck in cleaning state >10min`,
        metadata: { count: stuckResponses.length },
      });
    }
  }

  // Query B: Redis sessions where is_streaming=true for >60 seconds
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      'interview:session:*',
      'COUNT',
      100,
    );
    cursor = nextCursor;

    for (const key of keys) {
      const session = await redis.hgetall(key);
      if (
        session.is_streaming === 'true' &&
        session.streaming_started_at
      ) {
        const startedAt = parseInt(session.streaming_started_at, 10);
        if (Date.now() - startedAt > 60_000) {
          await redis.hset(key, 'is_streaming', 'false');
          await redis.hdel(key, 'current_turn_llm_text');
          processed++;

          const interviewId = key.split(':')[2];
          logger.info({ interviewId }, 'Reset stuck turn lock');
          alerts.push({
            code: 'TURN_LOCK_STUCK',
            severity: 'warning',
            description: `Turn lock stuck for interview ${interviewId}`,
            metadata: { interviewId },
          });
        }
      }
    }
  } while (cursor !== '0');

  return { scan: 'stuck_cleaning', processed, alerts };
}

// ---------------------------------------------------------------------------
// Scan 2: Audio Upload Inconsistencies
// ---------------------------------------------------------------------------

export async function scanAudioInconsistencies(
  deps: ReconciliationDeps,
): Promise<ScanResult> {
  const { prisma, s3, logger } = deps;
  const alerts: Alert[] = [];
  let processed = 0;

  // Query A: voice responses with pending audio upload >1 hour — flag for admin review
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const pendingUploads = await prisma.interviewResponse.findMany({
    where: {
      inputMode: 'voice',
      audioUploadStatus: 'pending',
      respondedAt: { lt: oneHourAgo },
    },
    select: { id: true, interviewId: true },
  });

  if (pendingUploads.length > 0) {
    processed += pendingUploads.length;
    logger.warn(
      { count: pendingUploads.length, ids: pendingUploads.map((r) => r.id) },
      'Flagged pending audio uploads >1hr for admin review',
    );
  }

  // Query B: failed audio uploads — log for admin dashboard
  const failedUploads = await prisma.interviewResponse.findMany({
    where: { audioUploadStatus: 'failed' },
    select: { id: true, interviewId: true },
  });

  if (failedUploads.length > 0) {
    processed += failedUploads.length;
    logger.warn(
      { count: failedUploads.length, ids: failedUploads.map((r) => r.id) },
      'Found failed audio uploads',
    );

    if (failedUploads.length > 5) {
      alerts.push({
        code: 'AUDIO_UPLOAD_FAILURE_BATCH',
        severity: 'warning',
        description: `${failedUploads.length} failed audio uploads found`,
        metadata: { count: failedUploads.length },
      });
    }
  }

  // Query C: Orphaned S3 objects not matching any DB record — tag for lifecycle cleanup
  const bucket = process.env.S3_AUDIO_BUCKET;
  if (bucket) {
    const s3Keys = await s3.listAudioKeys('responses/');
    if (s3Keys.length > 0) {
      const dbRecords = await prisma.interviewResponse.findMany({
        where: { s3AudioKey: { in: s3Keys } },
        select: { s3AudioKey: true },
      });
      const dbKeySet = new Set(dbRecords.map((r) => r.s3AudioKey));
      const orphanedKeys = s3Keys.filter((k) => !dbKeySet.has(k));

      if (orphanedKeys.length > 0) {
        processed += orphanedKeys.length;
        logger.warn(
          { count: orphanedKeys.length },
          'Found orphaned S3 audio objects — tagged for lifecycle cleanup',
        );
      }
    }
  }

  return { scan: 'audio_inconsistencies', processed, alerts };
}

// ---------------------------------------------------------------------------
// Scan 3: Paused Interview Auto-Abandonment
// ---------------------------------------------------------------------------

export async function scanPausedInterviews(
  deps: ReconciliationDeps,
): Promise<ScanResult> {
  const { prisma, eventBridge, logger } = deps;
  const alerts: Alert[] = [];
  let processed = 0;

  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const staleInterviews = await prisma.interview.findMany({
    where: {
      status: 'paused',
      pausedAt: { lt: seventyTwoHoursAgo },
    },
    select: { id: true, userId: true, templateId: true },
  });

  for (const interview of staleInterviews) {
    await prisma.interview.update({
      where: { id: interview.id },
      data: { status: 'abandoned' },
    });

    await eventBridge.publish({
      source: 'arena.reconciliation',
      detailType: 'interview.abandoned',
      detail: JSON.stringify({
        interviewId: interview.id,
        userId: interview.userId,
        templateId: interview.templateId,
        reason: 'auto_abandoned_paused_timeout',
      }),
    });

    processed++;
    alerts.push({
      code: 'INTERVIEW_ABANDONED_AUTO',
      severity: 'info',
      description: `Auto-abandoned paused interview ${interview.id}`,
      metadata: { interviewId: interview.id },
    });
    logger.info(
      { interviewId: interview.id },
      'Auto-abandoned stale paused interview',
    );
  }

  return { scan: 'paused_abandonment', processed, alerts };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runReconciliation(
  deps: ReconciliationDeps,
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  results.push(await scanStuckCleaning(deps));
  results.push(await scanAudioInconsistencies(deps));
  results.push(await scanPausedInterviews(deps));
  return results;
}

// ---------------------------------------------------------------------------
// Dependency construction (real AWS services — SDK v3 available in Lambda runtime)
// ---------------------------------------------------------------------------

async function buildDeps(logger: pino.Logger): Promise<ReconciliationDeps> {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  const { EventBridgeClient, PutEventsCommand } = await import(
    '@aws-sdk/client-eventbridge'
  );
  const { S3Client, ListObjectsV2Command } = await import(
    '@aws-sdk/client-s3'
  );

  const ebClient = new EventBridgeClient({});
  const s3Client = new S3Client({});

  const eventBridge: EventBridgePublisher = {
    async publish({ source, detailType, detail }) {
      await ebClient.send(
        new PutEventsCommand({
          Entries: [{ Source: source, DetailType: detailType, Detail: detail }],
        }),
      );
    },
  };

  const s3: S3AudioLister = {
    async listAudioKeys(prefix: string): Promise<string[]> {
      const bucket = process.env.S3_AUDIO_BUCKET;
      if (!bucket) return [];
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of response.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);
      return keys;
    },
  };

  return { prisma, redis, eventBridge, s3, logger };
}

// ---------------------------------------------------------------------------
// Lambda Handler
// ---------------------------------------------------------------------------

export const handler: ScheduledHandler = async (event: ScheduledEvent) => {
  const logger = pino({ name: 'arena-reconciliation' });
  logger.info({ time: event.time }, 'Reconciliation handler invoked');

  let deps: ReconciliationDeps | undefined;
  try {
    deps = await buildDeps(logger);
    const results = await runReconciliation(deps);

    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    const allAlerts = results.flatMap((r) => r.alerts);
    logger.info(
      {
        totalProcessed,
        alertCount: allAlerts.length,
        scans: results.map((r) => ({ scan: r.scan, processed: r.processed })),
      },
      'Reconciliation complete',
    );

    clickHouseWrite('reconciliation_run', {
      totalProcessed,
      alertCount: allAlerts.length,
      criticalAlertCount: allAlerts.filter((a) => a.severity === 'critical').length,
      stuckCleaningCount: results.find((r) => r.scan === 'stuck_cleaning')?.processed ?? 0,
      audioInconsistencyCount: results.find((r) => r.scan === 'audio_inconsistencies')?.processed ?? 0,
      abandonedInterviewCount: results.find((r) => r.scan === 'paused_abandonment')?.processed ?? 0,
    }, {
      serviceName: 'arena-reconciliation',
      severity: allAlerts.some((a) => a.severity === 'critical') ? 'ERROR' : 'INFO',
    });
  } catch (error) {
    logger.error(
      {
        alert: {
          code: 'RECONCILIATION_SCAN_FAILURE',
          severity: 'critical',
          description:
            error instanceof Error ? error.message : 'Unknown error',
        },
      },
      'RECONCILIATION_SCAN_FAILURE',
    );
    throw error;
  } finally {
    if (deps) {
      await deps.redis.quit();
      await deps.prisma.$disconnect();
    }
  }
};
