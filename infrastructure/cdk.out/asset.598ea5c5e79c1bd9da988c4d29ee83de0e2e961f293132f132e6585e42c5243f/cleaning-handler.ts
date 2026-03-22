import type { SQSEvent, SQSHandler } from 'aws-lambda';

/**
 * Cleaning Lambda — processes raw transcriptions after interview completion.
 * Stub handler; replaced in Task 1.
 */
export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('cleaning-handler invoked', { recordCount: event.Records.length });
};
