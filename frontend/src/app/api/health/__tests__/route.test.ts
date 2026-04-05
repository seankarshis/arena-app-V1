import { describe, expect, it, vi } from 'vitest';

// Mock next/server to avoid Next.js server runtime initialization in tests.
// NextResponse.json() is just a thin wrapper around Response — we replicate
// the parts the health handler actually uses.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { GET } from '../route';

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});
