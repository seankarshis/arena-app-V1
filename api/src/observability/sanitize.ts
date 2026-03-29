// ---------------------------------------------------------------------------
// Arena Observability — PII sanitization for structured logs
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const SALT = process.env.LOG_HASH_SALT ?? 'default-salt-change-me';

const PII_KEYS = [
  'email', 'phone', 'name', 'firstname', 'lastname',
  'address', 'street', 'postalcode', 'ip', 'password',
  'token', 'apikey', 'secret', 'ssn', 'dob', 'transcript',
  'questiontext', 'content',
];

function hashValue(value: string): string {
  return crypto.createHmac('sha256', SALT).update(value).digest('hex').slice(0, 16);
}

/**
 * Sanitize a key/value payload before writing to structured logs or ClickHouse.
 *
 * - Keys containing PII field names are redacted to '[REDACTED]'
 * - Keys that are both PII-adjacent AND contain 'id' are pseudonymized via HMAC-SHA256
 * - All other keys pass through unchanged
 *
 * Never pass raw user-derived objects to loggers without running through this first.
 */
export function sanitizeForLog(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (PII_KEYS.some((pii) => lowerKey.includes(pii))) {
        if (typeof value === 'string' && lowerKey.includes('id')) {
          return [key, hashValue(value)];
        }
        return [key, '[REDACTED]'];
      }
      return [key, value];
    }),
  );
}
