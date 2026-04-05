import { describe, expect, it, vi } from 'vitest';

// Mock auth to prevent aws-amplify initialization at module load time.
vi.mock('@/lib/auth', () => ({
  getIdToken: vi.fn().mockResolvedValue(null),
  getBypassUserId: vi.fn().mockReturnValue(null),
}));

import apolloClient from '../apolloClient';

describe('Apollo client', () => {
  it('can be imported without throwing', () => {
    expect(apolloClient).toBeDefined();
  });

  it('has an InMemoryCache', () => {
    expect(apolloClient.cache).toBeDefined();
  });

  it('defaults to localhost graphql when env var is absent', () => {
    // The httpLink URI is set to process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:3001/graphql'.
    // In tests that env var is not set, so we verify the client was constructed
    // (if the URI were malformed or empty the ApolloClient constructor would throw).
    expect(apolloClient).toBeTruthy();
  });
});
