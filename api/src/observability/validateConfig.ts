// ---------------------------------------------------------------------------
// Arena Observability — startup configuration validator
// Call validateObservabilityConfig() before buildServer() in server.ts
// ---------------------------------------------------------------------------

/**
 * Validates that required observability environment variables are present.
 *
 * Throws hard if OTEL_CLIENT_INSTALL_ID is missing — every ClickHouse write
 * requires this field for environment segregation (local vs staging vs prod
 * all write to the same ClickHouse cluster; install_id is the discriminator).
 *
 * Warns if LOG_HASH_SALT is missing — without it, PII pseudonymization falls
 * back to a static salt, making hashed IDs reversible across installs.
 */
export function validateObservabilityConfig(): void {
  if (!process.env.OTEL_CLIENT_INSTALL_ID) {
    throw new Error(
      '[Observability] OTEL_CLIENT_INSTALL_ID is not set in .env.local. ' +
        'All ClickHouse writes require this field for environment segregation. ' +
        'Add OTEL_CLIENT_INSTALL_ID=<your-install-id> to .env.local and restart.',
    );
  }
  if (!process.env.LOG_HASH_SALT) {
    console.warn(
      '[Observability] LOG_HASH_SALT is not set. Using default salt — set a real value in .env.local.',
    );
  }
  console.info('[Observability] config validated: install_id=%s', process.env.OTEL_CLIENT_INSTALL_ID);
}
