// ---------------------------------------------------------------------------
// Arena Observability — startup configuration validator + table bootstrap
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS arena_telemetry
(
  install_id  String,
  timestamp   DateTime64(3, 'UTC'),
  environment LowCardinality(String),
  event_type  LowCardinality(String),
  attributes  String
)
ENGINE = MergeTree()
ORDER BY (install_id, event_type, timestamp)
`.trim();

/**
 * Validates required observability env vars and ensures the arena_telemetry
 * table exists in ClickHouse. Call this once at server startup before
 * buildServer().
 *
 * Throws hard on OTEL_CLIENT_INSTALL_ID missing — every write requires it.
 * Warns (not throws) on missing ClickHouse credentials so the server still
 * starts in environments without telemetry configured.
 */
export async function validateObservabilityConfig(): Promise<void> {
  if (!process.env.OTEL_CLIENT_INSTALL_ID) {
    throw new Error(
      '[Observability] OTEL_CLIENT_INSTALL_ID is not set. ' +
        'Add OTEL_CLIENT_INSTALL_ID=<your-install-id> to .env.local and restart.',
    );
  }

  if (!process.env.LOG_HASH_SALT) {
    console.warn('[Observability] LOG_HASH_SALT is not set — using default salt. Set a real value in .env.local.');
  }

  const host = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const user = process.env.CLICKHOUSE_USER ?? 'default';
  const password = process.env.CLICKHOUSE_PASSWORD;

  if (!host || !password) {
    console.warn('[Observability] OTEL_EXPORTER_OTLP_ENDPOINT or CLICKHOUSE_PASSWORD not set — ClickHouse writes disabled.');
    return;
  }

  // Ensure the arena_telemetry table exists
  const url = `${host}/?query=${encodeURIComponent(CREATE_TABLE_SQL)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Observability] Failed to create arena_telemetry table (${res.status}): ${body.slice(0, 200)}`);
    } else {
      console.info('[Observability] arena_telemetry table ready. install_id=%s', process.env.OTEL_CLIENT_INSTALL_ID);
    }
  } catch (err) {
    console.warn('[Observability] Could not reach ClickHouse at startup:', err instanceof Error ? err.message : String(err));
  }
}
