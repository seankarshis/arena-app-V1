import type { ScheduledEvent, ScheduledHandler } from 'aws-lambda';

/**
 * Reconciliation Lambda — runs periodic scans for stuck states, upload
 * inconsistencies, paused interview abandonment, and data retention.
 * Stub handler; replaced in Task 10b.
 */
export const handler: ScheduledHandler = async (event: ScheduledEvent) => {
  console.log('reconciliation-handler invoked', { time: event.time });
};
