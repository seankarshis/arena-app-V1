// ---------------------------------------------------------------------------
// Arena OTel instrumentation bootstrap
// This file MUST be imported first in server.ts (before Fastify, Prisma, etc.)
// so the NodeSDK can install require() hooks before any instrumented modules load.
// ---------------------------------------------------------------------------

import { initTelemetry } from './middleware/otel';

initTelemetry();
