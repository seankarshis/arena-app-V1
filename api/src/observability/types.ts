// ---------------------------------------------------------------------------
// Arena Observability — canonical ClickHouse log entry interface
//
// This interface reflects the actual arena_telemetry table schema and the
// fields written by clickHouseWrite(). Keep in sync with validateConfig.ts.
// ---------------------------------------------------------------------------

export interface ClickHouseLogEntry {
  // Environment segregation (REQUIRED)
  install_id: string; // from OTEL_CLIENT_INSTALL_ID

  // Timestamp (REQUIRED)
  timestamp: string; // 'YYYY-MM-DD HH:MM:SS.mmm' UTC (ClickHouse DateTime64 format)

  // Service identity (REQUIRED)
  environment: string;   // "production" | "staging" | "local" (from NODE_ENV)
  service_name: string;  // e.g. "arena-api" | "arena-cleaning" | "arena-reconciliation" | "arena-stt-proxy"

  // Event classification (REQUIRED)
  event_type: string;    // snake_case e.g. "interview_lifecycle" | "llm_turns" | "stt_session"
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

  // OTel trace correlation (empty string when no active span)
  trace_id: string; // OpenTelemetry trace ID hex string
  span_id: string;  // OpenTelemetry span ID hex string

  // Payload (SANITIZED — no PII)
  // Contains event-specific fields. All values pass through sanitizeForLog()
  // before serialisation to JSON. Never include: names, emails, transcription
  // content, question text, or audit log change content.
  attributes: string; // JSON-serialised Record<string, unknown>
}
