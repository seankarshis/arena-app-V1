// ---------------------------------------------------------------------------
// Arena Observability — canonical ClickHouse log entry interface
// ---------------------------------------------------------------------------

export interface ClickHouseLogEntry {
  // Environment segregation (REQUIRED)
  install_id: string; // from OTEL_CLIENT_INSTALL_ID

  // Tracing (REQUIRED)
  trace_id: string; // OpenTelemetry trace ID
  span_id: string; // OpenTelemetry span ID
  timestamp: string; // ISO 8601 UTC

  // Event classification (REQUIRED)
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  service_name: string; // e.g. "api-gateway", "interview-engine"
  event_name: string; // snake_case e.g. "user_login_attempt"

  // Context (RECOMMENDED)
  environment: string; // "production" | "staging" | "local"
  version: string; // app/service version

  // Payload (SANITIZED — no PII)
  attributes: Record<string, string | number | boolean>;

  // Error details (when applicable)
  error_type?: string;
  error_message?: string; // Must be scrubbed of PII
  stack_trace?: string; // Must not expose infra paths or user input
}
