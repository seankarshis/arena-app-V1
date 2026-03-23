// ---------------------------------------------------------------------------
// Arena GraphQL Context — per-request context with auth + DataLoaders
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import type { AuthUser } from '../middleware/auth';
import { createDataLoaders, type ArenaDataLoaders } from './dataLoaders';

export interface ArenaContext {
  user: AuthUser | null;
  prisma: PrismaClient;
  loaders: ArenaDataLoaders;
}

/**
 * Creates a fresh ArenaContext for each incoming GraphQL request.
 * DataLoaders are per-request to ensure correct caching/batching boundaries.
 */
export function buildArenaContext(
  user: AuthUser | null,
  prisma: PrismaClient,
): ArenaContext {
  return {
    user,
    prisma,
    loaders: createDataLoaders(prisma),
  };
}
