// ---------------------------------------------------------------------------
// Arena bootstrap — env loading + OTel instrumentation
// MUST be the first import in server.ts so env vars are set before any
// module reads process.env, and OTel SDK starts before instrumented modules load.
// ---------------------------------------------------------------------------

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env then .env.local (local overrides shared)
config({ path: resolve(__dirname, '../../.env') });
config({ path: resolve(__dirname, '../../.env.local'), override: true });

import { initTelemetry } from './middleware/otel';

initTelemetry();
