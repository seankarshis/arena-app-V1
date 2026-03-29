// ---------------------------------------------------------------------------
// Arena Observability — ClickHouse write helper
// Writes directly to the ClickHouse HTTP SQL interface (POST /?query=INSERT…).
// Fire-and-forget: failures are logged but never propagate to callers.
// ---------------------------------------------------------------------------

import { sanitizeForLog } from './sanitize';

function getConfig(): { url: string; auth: string } | null {
  const host = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const user = process.env.CLICKHOUSE_USER ?? 'default';
  const password = process.env.CLICKHOUSE_PASSWORD;

  if (!host || !password) return null;

  return {
    url: host,
    auth: Buffer.from(`${user}:${password}`).toString('base64'),
  };
}

/**
 * Write a sanitized row to ClickHouse.
 *
 * Automatically injects install_id, timestamp, environment, and event_type.
 * The payload is run through sanitizeForLog — PII fields are redacted.
 * Uses the arena_telemetry table (created at startup by validateObservabilityConfig).
 *
 * Silently no-ops if OTEL_EXPORTER_OTLP_ENDPOINT or CLICKHOUSE_PASSWORD are unset.
 */
export function clickHouseWrite(
  eventType: string,
  payload: Record<string, unknown>,
): void {
  const installId = process.env.OTEL_CLIENT_INSTALL_ID;
  if (!installId) return; // validateObservabilityConfig warns loudly at startup

  const cfg = getConfig();
  if (!cfg) return; // ClickHouse not configured — skip silently

  const sanitized = sanitizeForLog(payload);
  const row = {
    install_id: installId,
    timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
    environment: process.env.NODE_ENV ?? 'unknown',
    event_type: eventType,
    attributes: JSON.stringify(sanitized),
  };

  const query = 'INSERT INTO arena_telemetry FORMAT JSONEachRow';
  const url = `${cfg.url}/?query=${encodeURIComponent(query)}`;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${cfg.auth}`,
    },
    body: JSON.stringify(row),
  }).then((res) => {
    if (!res.ok) {
      res.text().then((body) => {
        console.warn(`[ClickHouse] INSERT failed (${res.status}): ${body.slice(0, 200)}`);
      });
    }
  }).catch((err: unknown) => {
    console.warn('[ClickHouse] INSERT error:', err instanceof Error ? err.message : String(err));
  });
}
