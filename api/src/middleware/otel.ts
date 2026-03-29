import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Span } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// PII attribute patterns — keys or values matching these are redacted
// ---------------------------------------------------------------------------

const PII_KEY_PATTERNS: RegExp[] = [
  /email/i,
  /user[._-]?name/i,
  /display[._-]?name/i,
  /first[._-]?name/i,
  /last[._-]?name/i,
  /full[._-]?name/i,
  /phone/i,
  /address/i,
  /transcription/i,
  /transcript/i,
  /question[._-]?text/i,
  /cleaned[._-]?markdown/i,
  /raw[._-]?content/i,
  /knowledge[._-]?fabric/i,
  /audit[._-]?changes/i,
  /changes/i,
  /body/i,
  /password/i,
  /secret/i,
  /authorization/i,
  /cookie/i,
  /token/i,
];

// Matches common email patterns in string values
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function isPiiKey(key: string): boolean {
  return PII_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function containsEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// PII-scrubbing span processor
// Wraps a delegate processor — scrubs attributes before forwarding to export
// ---------------------------------------------------------------------------

export class PiiScrubbingSpanProcessor implements SpanProcessor {
  private readonly _delegate: SpanProcessor;

  constructor(delegate: SpanProcessor) {
    this._delegate = delegate;
  }

  onStart(span: Span, parentContext: Context): void {
    this._delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this._scrubAttributes(span);
    this._delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this._delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this._delegate.shutdown();
  }

  private _scrubAttributes(span: ReadableSpan): void {
    const attrs = span.attributes;
    for (const key of Object.keys(attrs)) {
      if (isPiiKey(key)) {
        attrs[key] = '[REDACTED]';
        continue;
      }

      const value = attrs[key];
      if (typeof value === 'string' && containsEmail(value)) {
        attrs[key] = '[REDACTED]';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Alert helper — emits structured log events to ClickHouse via OTel
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertEvent {
  code: string;
  severity: AlertSeverity;
  component: string;
  message: string;
  interviewId?: string;
  count?: number;
}

/**
 * Emit a structured alert event as an OTel span event.
 * These are queryable in ClickHouse via `LogAttributes['alert.code']`.
 */
export function emitAlert(event: AlertEvent): void {
  const { trace } = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
  const span = trace.getActiveSpan();
  if (!span) return;

  const attributes: Record<string, string | number> = {
    'alert.code': event.code,
    'alert.severity': event.severity,
    'alert.component': event.component,
    'alert.message': event.message,
  };

  if (event.interviewId) {
    attributes['alert.interview_id'] = event.interviewId;
  }
  if (event.count !== undefined) {
    attributes['alert.count'] = event.count;
  }

  span.addEvent('alert', attributes);
}

// ---------------------------------------------------------------------------
// SDK initialisation — call before server starts
// ---------------------------------------------------------------------------

let sdk: NodeSDK | null = null;

export function initTelemetry(): NodeSDK {
  if (sdk) return sdk;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const chUser = process.env.CLICKHOUSE_USER;
  const chPassword = process.env.CLICKHOUSE_PASSWORD;

  const traceExporter = new OTLPTraceExporter({
    url: endpoint ? `${endpoint}/v1/traces` : undefined,
    headers:
      chUser && chPassword
        ? {
            Authorization: `Basic ${Buffer.from(`${chUser}:${chPassword}`).toString('base64')}`,
          }
        : undefined,
  });

  const batchProcessor = new BatchSpanProcessor(traceExporter);
  const piiProcessor = new PiiScrubbingSpanProcessor(batchProcessor);

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'arena-api',
    spanProcessors: [piiProcessor],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation — very noisy, no observability value
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Disable DNS — noisy, low value
        '@opentelemetry/instrumentation-dns': { enabled: false },
        // Disable net — low value for our use case
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown
  const shutdownHandler = async () => {
    if (sdk) {
      await sdk.shutdown();
    }
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  return sdk;
}

export function getOtelSdk(): NodeSDK | null {
  return sdk;
}
