import { GraphQLError } from 'graphql';
import { trace, SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Typed error codes — the standard vocabulary for all Arena GraphQL errors
// ---------------------------------------------------------------------------

export const ErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  INVALID_STATE: 'INVALID_STATE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// Errors logged at WARN level (business rule violations)
const WARN_CODES = new Set<string>([
  ErrorCode.NOT_FOUND,
  ErrorCode.DUPLICATE_ENTRY,
  ErrorCode.INVALID_STATE,
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.CONSENT_REQUIRED,
  ErrorCode.FORBIDDEN,
  ErrorCode.RATE_LIMITED,
]);

// Errors logged at ERROR level (infrastructure failures)
const ERROR_CODES = new Set<string>([
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.EXTERNAL_SERVICE_ERROR,
]);

// ---------------------------------------------------------------------------
// ArenaError — typed GraphQL error with OTel span recording
// ---------------------------------------------------------------------------

export interface ArenaErrorDetails {
  [key: string]: unknown;
}

export class ArenaError extends GraphQLError {
  constructor(
    message: string,
    code: ErrorCode,
    details?: ArenaErrorDetails,
  ) {
    super(message, {
      extensions: {
        code,
        ...(details ? { details } : {}),
      },
    });

    // Record on the active OTel span
    recordErrorOnSpan(code, message, details);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory functions for each error code
// ---------------------------------------------------------------------------

export function notFound(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.NOT_FOUND, details);
}

export function duplicateEntry(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.DUPLICATE_ENTRY, details);
}

export function invalidState(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.INVALID_STATE, details);
}

export function unauthorized(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.UNAUTHORIZED, details);
}

export function forbidden(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.FORBIDDEN, details);
}

export function validationError(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.VALIDATION_ERROR, details);
}

export function internalError(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.INTERNAL_ERROR, details);
}

export function externalServiceError(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.EXTERNAL_SERVICE_ERROR, details);
}

export function rateLimited(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.RATE_LIMITED, details);
}

export function consentRequired(message: string, details?: ArenaErrorDetails): ArenaError {
  return new ArenaError(message, ErrorCode.CONSENT_REQUIRED, details);
}

// ---------------------------------------------------------------------------
// OTel span recording — logs error events with no PII
// ---------------------------------------------------------------------------

function recordErrorOnSpan(
  code: ErrorCode,
  message: string,
  details?: ArenaErrorDetails,
): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  const isError = ERROR_CODES.has(code);
  const isWarn = WARN_CODES.has(code);

  // Build safe attributes — only UUIDs, codes, and metrics. No user content.
  const eventAttributes: Record<string, string | number> = {
    'error.code': code,
    'error.message': message,
    'error.level': isError ? 'ERROR' : isWarn ? 'WARN' : 'INFO',
  };

  // Extract only safe detail values (UUIDs, statuses, counts, reasons)
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'string' || typeof value === 'number') {
        eventAttributes[`error.details.${key}`] = value;
      }
    }
  }

  span.addEvent('graphql.error', eventAttributes);

  // Set span status to ERROR for infrastructure-level errors
  if (isError) {
    span.setStatus({ code: SpanStatusCode.ERROR, message });
  }
}

// ---------------------------------------------------------------------------
// Apollo formatError plugin — strips stack traces in production
// ---------------------------------------------------------------------------

export interface FormattedGraphQLError {
  message: string;
  locations?: ReadonlyArray<{ line: number; column: number }>;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
}

export function formatArenaError(
  formattedError: FormattedGraphQLError,
): FormattedGraphQLError {
  if (process.env.NODE_ENV === 'production') {
    // Remove stack traces — keep only message + extensions
    return {
      message: formattedError.message,
      extensions: formattedError.extensions,
    };
  }
  return formattedError;
}
