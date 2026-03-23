import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleaningResult {
  responseId: string;
  status: 'cleaned' | 'error';
  errorMessage?: string;
}

export interface ClaudeApiClient {
  clean(rawTranscription: string): Promise<{
    cleanedMarkdown: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }>;
}

export interface CleaningDeps {
  prisma: PrismaClient;
  claude: ClaudeApiClient;
  logger: pino.Logger;
}

// ---------------------------------------------------------------------------
// Cleaning Prompt
// ---------------------------------------------------------------------------

const CLEANING_SYSTEM_PROMPT = `You are a transcription cleaning assistant. Your task is to clean raw interview transcriptions.

Instructions:
- Remove filler words (um, uh, like, you know, etc.)
- Fix grammar and punctuation
- Structure the text into coherent paragraphs
- Preserve the interviewee's voice, meaning, and intent exactly
- Output clean markdown text only — no explanations, preamble, or commentary`;

// ---------------------------------------------------------------------------
// Core: Process a single interview
// ---------------------------------------------------------------------------

export async function processInterview(
  interviewId: string,
  deps: CleaningDeps,
): Promise<CleaningResult[]> {
  const { prisma, claude, logger } = deps;
  const results: CleaningResult[] = [];

  const responses = await prisma.interviewResponse.findMany({
    where: {
      interviewId,
      rawTranscription: { not: null },
      processingStatus: 'pending',
    },
    select: {
      id: true,
      rawTranscription: true,
    },
    orderBy: { sequenceNumber: 'asc' },
  });

  if (responses.length === 0) {
    logger.info({ interviewId }, 'No pending responses to clean');
    return results;
  }

  logger.info(
    { interviewId, responseCount: responses.length },
    'Starting cleaning for interview',
  );

  for (const response of responses) {
    try {
      await prisma.interviewResponse.update({
        where: { id: response.id },
        data: { processingStatus: 'cleaning' },
      });

      const cleanResult = await claude.clean(response.rawTranscription!);

      await prisma.$transaction([
        prisma.interviewResponse.update({
          where: { id: response.id },
          data: {
            cleanedMarkdown: cleanResult.cleanedMarkdown,
            cleaningModel: cleanResult.model,
            cleanedAt: new Date(),
            llmPromptTokens: cleanResult.promptTokens,
            llmCompletionTokens: cleanResult.completionTokens,
            processingStatus: 'cleaned',
          },
        }),
        prisma.interview.update({
          where: { id: interviewId },
          data: {
            totalLlmPromptTokens: { increment: cleanResult.promptTokens },
            totalLlmCompletionTokens: { increment: cleanResult.completionTokens },
          },
        }),
      ]);

      results.push({ responseId: response.id, status: 'cleaned' });
      logger.info(
        {
          responseId: response.id,
          model: cleanResult.model,
          promptTokens: cleanResult.promptTokens,
          completionTokens: cleanResult.completionTokens,
        },
        'Response cleaned successfully',
      );
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown cleaning error';

      await prisma.interviewResponse
        .update({
          where: { id: response.id },
          data: {
            processingStatus: 'error',
            errorMessage,
          },
        })
        .catch((updateErr) => {
          logger.error(
            { responseId: response.id, error: updateErr },
            'Failed to set error status on response',
          );
        });

      results.push({
        responseId: response.id,
        status: 'error',
        errorMessage,
      });
      logger.error(
        { responseId: response.id, errorMessage },
        'CLEANING_PIPELINE_ERROR',
      );
    }
  }

  const errorCount = results.filter((r) => r.status === 'error').length;
  const errorRate = errorCount / results.length;
  if (errorRate > 0.1) {
    logger.error(
      {
        alert: {
          code: 'CLEANING_PIPELINE_ERROR_RATE',
          severity: 'critical',
          description: `Cleaning error rate ${(errorRate * 100).toFixed(1)}% exceeds 10% threshold`,
          metadata: {
            interviewId,
            totalResponses: results.length,
            errorCount,
          },
        },
      },
      'CLEANING_PIPELINE_ERROR_RATE',
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Claude API client factory
// ---------------------------------------------------------------------------

export function createClaudeClient(apiKey: string): ClaudeApiClient {
  return {
    async clean(rawTranscription: string) {
      // @ts-expect-error — package installed at deploy time, not in dev dependencies
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: CLEANING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawTranscription }],
      });

      const textBlock = message.content.find(
        (block: { type: string }) => block.type === 'text',
      );
      const cleanedMarkdown = textBlock?.text ?? '';

      return {
        cleanedMarkdown,
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
  const logger = pino({ name: 'arena-cleaning' });
  logger.info({ recordCount: event.Records.length }, 'Cleaning handler invoked');

  const prisma = new PrismaClient();
  const apiKey = process.env.CLAUDE_API_KEY;

  if (!apiKey) {
    logger.error('CLAUDE_API_KEY not set');
    throw new Error('CLAUDE_API_KEY environment variable is required');
  }

  const claude = createClaudeClient(apiKey);
  const deps: CleaningDeps = { prisma, claude, logger };

  try {
    for (const record of event.Records) {
      const body = JSON.parse(record.body);
      const detail =
        typeof body.detail === 'string' ? JSON.parse(body.detail) : body.detail ?? body;
      const interviewId: string = detail.interviewId;

      if (!interviewId) {
        logger.error({ body: record.body }, 'Missing interviewId in SQS message');
        continue;
      }

      const results = await processInterview(interviewId, deps);
      const cleaned = results.filter((r) => r.status === 'cleaned').length;
      const errors = results.filter((r) => r.status === 'error').length;

      logger.info(
        { interviewId, cleaned, errors, total: results.length },
        'Interview cleaning complete',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
};
