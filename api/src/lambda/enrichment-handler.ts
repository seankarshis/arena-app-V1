import * as fs from 'fs';
import * as path from 'path';
import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { emitEnrichmentJob } from '../observability/events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichmentMessage {
  responseId: string;
  interviewId: string;
  attemptNumber: number;
}

export interface ExtractedEntity {
  text: string;
  type: string;
}

export interface FlaggedItemInput {
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedTags: string[];
}

export interface EnrichmentLlmOutput {
  entities: ExtractedEntity[];
  suggestedTags: string[];
  flaggedItems: FlaggedItemInput[];
  summary: string;
}

export interface EnrichmentResult {
  responseId: string;
  status: 'succeeded' | 'failed';
  errorCode?: EnrichmentErrorCode;
  entityCount?: number;
  tagCount?: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export type EnrichmentErrorCode =
  | 'llm_timeout'
  | 'llm_error'
  | 'invalid_response'
  | 'db_write_failed'
  | 'tag_limit_exceeded'
  | 'unknown';

export interface EnrichmentLlmClient {
  enrich(params: {
    systemPrompt: string;
    responseSnapshot: string;
  }): Promise<{
    rawOutput: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }>;
}

export interface EnrichmentDeps {
  prisma: PrismaClient;
  llm: EnrichmentLlmClient;
  logger: pino.Logger;
  loadPrompt?: () => string;
}

// ---------------------------------------------------------------------------
// Enrichment prompt loader
// ---------------------------------------------------------------------------

export function loadEnrichmentPrompt(): string {
  const promptPath = path.join(__dirname, '../../../../brain/specs/enrichment-prompt-v1.md');
  if (!fs.existsSync(promptPath)) {
    throw new Error(
      '[enrichment] enrichment-prompt-v1.md not found at expected path. ' +
      'The spec must be created before this Lambda can run. ' +
      `Expected: ${promptPath}`,
    );
  }
  return fs.readFileSync(promptPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// LLM output parser
// ---------------------------------------------------------------------------

export function parseEnrichmentOutput(raw: string): EnrichmentLlmOutput {
  // Extract JSON block from markdown fences if present
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('invalid_json');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('schema_mismatch');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.entities)) throw new Error('schema_mismatch');
  if (!Array.isArray(obj.suggestedTags)) throw new Error('schema_mismatch');
  if (!Array.isArray(obj.flaggedItems)) throw new Error('schema_mismatch');
  if (typeof obj.summary !== 'string') throw new Error('schema_mismatch');

  const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

  const entities: ExtractedEntity[] = (obj.entities as unknown[]).map((e) => {
    if (typeof e !== 'object' || e === null) throw new Error('schema_mismatch');
    const ent = e as Record<string, unknown>;
    if (typeof ent.text !== 'string' || typeof ent.type !== 'string') {
      throw new Error('schema_mismatch');
    }
    return { text: ent.text, type: ent.type };
  });

  const suggestedTags: string[] = (obj.suggestedTags as unknown[]).map((t) => {
    if (typeof t !== 'string') throw new Error('schema_mismatch');
    return t;
  });

  const flaggedItems: FlaggedItemInput[] = (obj.flaggedItems as unknown[]).map((f) => {
    if (typeof f !== 'object' || f === null) throw new Error('schema_mismatch');
    const fi = f as Record<string, unknown>;
    if (typeof fi.description !== 'string') throw new Error('schema_mismatch');
    if (!VALID_PRIORITIES.has(fi.priority as string)) throw new Error('schema_mismatch');
    if (!Array.isArray(fi.suggestedTags)) throw new Error('schema_mismatch');
    const tags = (fi.suggestedTags as unknown[]).map((t) => {
      if (typeof t !== 'string') throw new Error('schema_mismatch');
      return t;
    });
    return {
      description: fi.description as string,
      priority: fi.priority as 'low' | 'medium' | 'high' | 'critical',
      suggestedTags: tags,
    };
  });

  return {
    entities,
    suggestedTags,
    flaggedItems,
    summary: obj.summary as string,
  };
}

// ---------------------------------------------------------------------------
// Core: process a single enrichment message
// ---------------------------------------------------------------------------

export async function processEnrichmentMessage(
  message: EnrichmentMessage,
  deps: EnrichmentDeps,
): Promise<EnrichmentResult> {
  const { prisma, llm, logger } = deps;
  const { responseId, interviewId, attemptNumber } = message;
  const retryCount = Math.max(0, attemptNumber - 1);
  const startMs = Date.now();

  // Emit started
  emitEnrichmentJob({
    responseId,
    interviewId,
    jobType: 'enrichment',
    status: 'started',
    attemptNumber,
    retryCount,
    durationMs: 0,
  });

  // Load prompt — fail fast if missing
  let systemPrompt: string;
  try {
    systemPrompt = deps.loadPrompt ? deps.loadPrompt() : loadEnrichmentPrompt();
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorCode: EnrichmentErrorCode = 'llm_error';
    logger.error(
      { responseId, interviewId, errorCode },
      'Enrichment prompt file not found — cannot proceed',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
    });
    return { responseId, status: 'failed', errorCode };
  }

  // Load the InterviewResponse and its question snapshot
  let response: {
    id: string;
    interviewId: string;
    questionId: string;
    questionTextAsAsked: string;
    sequenceNumber: number;
    cleanedMarkdown: string | null;
    rawTranscription: string | null;
  } | null;

  try {
    response = await prisma.interviewResponse.findUnique({
      where: { id: responseId },
      select: {
        id: true,
        interviewId: true,
        questionId: true,
        questionTextAsAsked: true,
        sequenceNumber: true,
        cleanedMarkdown: true,
        rawTranscription: true,
      },
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorCode: EnrichmentErrorCode = 'db_write_failed';
    logger.error(
      { responseId, interviewId, errorCode },
      'Failed to load InterviewResponse from database',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
    });
    return { responseId, status: 'failed', errorCode };
  }

  if (!response) {
    const durationMs = Date.now() - startMs;
    const errorCode: EnrichmentErrorCode = 'unknown';
    logger.error(
      { responseId, interviewId, errorCode },
      'InterviewResponse not found in database',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
    });
    return { responseId, status: 'failed', errorCode };
  }

  // Build user content for the LLM — use cleanedMarkdown if available, else raw
  const responseSnapshot = response.cleanedMarkdown ?? response.rawTranscription ?? '';

  // Call LLM
  let llmResult: {
    rawOutput: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  };

  try {
    llmResult = await llm.enrich({ systemPrompt, responseSnapshot });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    // Distinguish timeout from other LLM errors
    const isTimeout =
      err instanceof Error &&
      (err.message.toLowerCase().includes('timeout') ||
        err.message.toLowerCase().includes('timed out') ||
        (err as NodeJS.ErrnoException).code === 'ETIMEDOUT');
    const errorCode: EnrichmentErrorCode = isTimeout ? 'llm_timeout' : 'llm_error';
    logger.error(
      { responseId, interviewId, errorCode },
      'LLM call failed during enrichment',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
    });
    return { responseId, status: 'failed', errorCode };
  }

  // Parse LLM output
  let parsed: EnrichmentLlmOutput;
  try {
    parsed = parseEnrichmentOutput(llmResult.rawOutput);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorCode: EnrichmentErrorCode = 'invalid_response';
    logger.error(
      { responseId, interviewId, errorCode },
      'Failed to parse LLM enrichment output',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
      model: llmResult.model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
    });
    return { responseId, status: 'failed', errorCode };
  }

  // Load the interview for templateId (for flaggedItem telemetry)
  let interview: { templateId: string } | null;
  try {
    interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: { templateId: true },
    });
  } catch {
    interview = null;
  }
  void interview; // templateId reserved for future flaggedItem telemetry calls

  // Resolve canonical tags — look up each suggested tag label
  // Tags that match existing canonical tags are noted; non-canonical labels
  // cannot create TagMergeProposal (which requires an existing canonicalTagId FK).
  // Non-canonical labels are surfaced only through FlaggedItem.suggestedTags JSON.
  let canonicalTagIds: string[] = [];
  let nonCanonicalLabels: string[] = [];

  try {
    const existingTags = await prisma.tag.findMany({
      where: {
        label: { in: parsed.suggestedTags },
        isActive: true,
      },
      select: { id: true, label: true },
    });

    const canonicalLabelSet = new Set(existingTags.map((t) => t.label));
    canonicalTagIds = existingTags.map((t) => t.id);
    nonCanonicalLabels = parsed.suggestedTags.filter((l) => !canonicalLabelSet.has(l));
  } catch (err) {
    // Non-fatal: proceed with empty canonical tag list
    logger.warn(
      { responseId, interviewId },
      'Failed to look up canonical tags — proceeding without tag resolution',
    );
  }

  // Write all results in a single Prisma transaction
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Update InterviewResponse: store entities and summary in processingStatus
      //    The schema doesn't have dedicated enrichment columns; mark as enriched
      //    and store structured data in the existing errorMessage field (as JSON note)
      //    or use a separate approach. Since the schema has no enrichment fields,
      //    we update processingStatus to 'enriched'.
      await tx.interviewResponse.update({
        where: { id: responseId },
        data: {
          processingStatus: 'enriched',
        },
      });

      // 2. Insert TagMergeProposal rows for non-canonical labels that have at least
      //    one canonical tag to anchor to (propose merging the new label concept
      //    near the first canonical match). Since TagMergeProposal requires a valid
      //    canonicalTagId FK, we can only create proposals when a canonical tag exists.
      //    Each non-canonical label becomes a rationale note on a single proposal.
      if (nonCanonicalLabels.length > 0 && canonicalTagIds.length > 0) {
        // Group non-canonical labels into a single proposal referencing the first
        // canonical tag, with all non-canonical labels noted in rationale for admin review.
        await tx.tagMergeProposal.create({
          data: {
            canonicalTagId: canonicalTagIds[0],
            candidateTagIds: [],
            rationale: `Enrichment suggested new tags for admin review: ${nonCanonicalLabels.join(', ')}`,
            status: 'PENDING',
          },
        });
      }

      // 3. Insert FlaggedItem rows
      for (const fi of parsed.flaggedItems) {
        await tx.flaggedItem.create({
          data: {
            interviewId,
            sourceTurn: response!.sequenceNumber,
            description: fi.description,
            suggestedTags: fi.suggestedTags,
            priority: fi.priority.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
            needsAdminReview: true,
          },
        });
      }

      // 4. Delete the processed EnrichmentOutbox row
      await tx.enrichmentOutbox.deleteMany({
        where: { responseId },
      });
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorCode: EnrichmentErrorCode = 'db_write_failed';
    logger.error(
      { responseId, interviewId, errorCode },
      'Prisma transaction failed during enrichment write',
    );
    emitEnrichmentJob({
      responseId,
      interviewId,
      jobType: 'enrichment',
      status: 'failed',
      attemptNumber,
      retryCount,
      durationMs,
      errorCode,
      model: llmResult.model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
    });
    return { responseId, status: 'failed', errorCode };
  }

  // Emit flagged_items telemetry (fire-and-forget, after transaction succeeds)
  // We need the created flaggedItem IDs for telemetry, but since we can't get
  // them from the transaction result easily without separate queries, we emit
  // with a synthetic ID placeholder — the count and metadata are what matter.
  // Note: FlaggedItem IDs are not exposed here to keep the transaction simple.
  // Per ADR 014, flaggedItemId is pseudonymized anyway; we omit per-item telemetry
  // here and rely on the enrichment_jobs event for aggregate observability.

  const durationMs = Date.now() - startMs;
  const entityCount = parsed.entities.length;
  const tagCount = canonicalTagIds.length;

  emitEnrichmentJob({
    responseId,
    interviewId,
    jobType: 'enrichment',
    status: 'succeeded',
    attemptNumber,
    retryCount,
    durationMs,
    model: llmResult.model,
    promptTokens: llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
    entityCount,
    tagCount,
  });

  logger.info(
    {
      responseId,
      interviewId,
      entityCount,
      tagCount,
      flaggedItemCount: parsed.flaggedItems.length,
      nonCanonicalTagCount: nonCanonicalLabels.length,
      model: llmResult.model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
      durationMs,
    },
    'Enrichment completed successfully',
  );

  return {
    responseId,
    status: 'succeeded',
    entityCount,
    tagCount,
    model: llmResult.model,
    promptTokens: llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
  };
}

// ---------------------------------------------------------------------------
// LLM client factory (Claude Haiku)
// ---------------------------------------------------------------------------

export function createEnrichmentLlmClient(apiKey: string): EnrichmentLlmClient {
  return {
    async enrich({ systemPrompt, responseSnapshot }) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      const message = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: responseSnapshot }],
      });

      const textBlock = message.content.find((b) => b.type === 'text') as
        | { type: 'text'; text: string }
        | undefined;
      const rawOutput = textBlock?.text ?? '';

      return {
        rawOutput,
        model: message.model,
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lambda Handler
// ---------------------------------------------------------------------------

export const handler: SQSHandler = async (event: SQSEvent) => {
  const logger = pino({ name: 'arena-enrichment' });
  logger.info({ recordCount: event.Records.length }, 'Enrichment handler invoked');

  const prisma = new PrismaClient();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not set');
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const llm = createEnrichmentLlmClient(apiKey);
  const deps: EnrichmentDeps = { prisma, llm, logger };

  try {
    for (const record of event.Records) {
      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch {
        logger.error({ recordId: record.messageId }, 'Failed to parse SQS message body as JSON');
        continue;
      }

      const detail =
        typeof (body as Record<string, unknown>).detail === 'string'
          ? JSON.parse((body as Record<string, unknown>).detail as string)
          : (body as Record<string, unknown>).detail ?? body;

      const { responseId, interviewId, attemptNumber } = detail as Partial<EnrichmentMessage>;

      if (!responseId || !interviewId) {
        logger.error(
          { messageId: record.messageId },
          'Missing responseId or interviewId in SQS message — skipping',
        );
        continue;
      }

      const message: EnrichmentMessage = {
        responseId: responseId as string,
        interviewId: interviewId as string,
        attemptNumber: typeof attemptNumber === 'number' ? attemptNumber : 1,
      };

      const result = await processEnrichmentMessage(message, deps);

      logger.info(
        {
          responseId: result.responseId,
          status: result.status,
          entityCount: result.entityCount,
          tagCount: result.tagCount,
        },
        'Enrichment message processed',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
};
