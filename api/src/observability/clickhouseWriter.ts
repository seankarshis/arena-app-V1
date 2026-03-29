// ---------------------------------------------------------------------------
// Arena Observability — ClickHouse write helper
// Emits sanitized entries as OTel span events (routed to ClickHouse via OTLP)
// ---------------------------------------------------------------------------

import { trace } from '@opentelemetry/api';
import { sanitizeForLog } from './sanitize';

const tracer = trace.getTracer('arena-api');

/**
 * Write a sanitized entry to ClickHouse via OTel span events.
 *
 * If an active span exists (e.g. an HTTP request context), the event is added
 * to it. If not (background timers, Lambda invocations), a short-lived root
 * span is created so the data still reaches ClickHouse.
 *
 * Every write automatically injects:
 *   - install_id: from OTEL_CLIENT_INSTALL_ID (required; throws if missing)
 *   - timestamp: current UTC ISO string
 *   - environment: NODE_ENV
 *
 * The payload is run through sanitizeForLog — PII fields are redacted and
 * ID fields are pseudonymized.
 */
export function clickHouseWrite(
  table: string,
  payload: Record<string, unknown>,
): void {
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

  const attrs: Record<string, string | number | boolean> = {
    'ch.table': table,
  };
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      attrs[`ch.${k}`] = v;
    }
  }

  // Use the active span when available (HTTP/GraphQL request context).
  // Otherwise create a short-lived root span — this handles background timers
  // and Lambda invocations where no parent span exists.
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    activeSpan.addEvent(`clickhouse.write.${table}`, attrs);
  } else {
    const span = tracer.startSpan(`arena.clickhouse.${table}`);
    span.addEvent(`clickhouse.write.${table}`, attrs);
    span.end();
  }
}
