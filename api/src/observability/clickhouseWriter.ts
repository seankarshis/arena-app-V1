// ---------------------------------------------------------------------------
// Arena Observability — ClickHouse write helper
// Emits sanitized entries as OTel span events (routed to ClickHouse via OTLP)
// ---------------------------------------------------------------------------

import { trace } from '@opentelemetry/api';
import { sanitizeForLog } from './sanitize';

/**
 * Write a sanitized entry to ClickHouse via the active OTel span.
 *
 * Every write automatically injects:
 *   - install_id: from OTEL_CLIENT_INSTALL_ID (required; throws if missing)
 *   - timestamp: current UTC ISO string
 *   - environment: NODE_ENV
 *
 * The payload is run through sanitizeForLog before emission — PII fields are
 * redacted and ID fields are pseudonymized.
 *
 * @param table  Logical ClickHouse table name (used as the span event name suffix)
 * @param payload  Raw key/value data to record — will be sanitized before write
 */
export async function clickHouseWrite(
  table: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const installId = process.env.OTEL_CLIENT_INSTALL_ID;
  if (!installId) {
    throw new Error('[ClickHouse] OTEL_CLIENT_INSTALL_ID must be set before writing logs.');
  }

  const sanitized = sanitizeForLog(payload);
  const entry: Record<string, unknown> = {
    install_id: installId,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV ?? 'unknown',
    ...sanitized,
  };

  // Emit as a structured span event — the OTLP exporter routes this to ClickHouse
  const span = trace.getActiveSpan();
  if (span) {
    const attrs: Record<string, string | number | boolean> = {
      'ch.table': table,
    };
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attrs[`ch.${k}`] = v;
      }
    }
    span.addEvent(`clickhouse.write.${table}`, attrs);
  }
}
