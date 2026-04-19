// ---------------------------------------------------------------------------
// migrateTriggersToAdminNotes.test.ts
//
// Unit tests for the followupTriggers → adminNotes migration script.
// Uses a mock Prisma client — no real DB required.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMigration, formatTriggersAsNotes } from '../scripts/migrate-triggers-to-admin-notes';
import type { MigrationDeps } from '../scripts/migrate-triggers-to-admin-notes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(
  id: string,
  followupTriggers: unknown,
  adminNotes: string | null = null,
) {
  return { id, followupTriggers, adminNotes };
}

// ---------------------------------------------------------------------------
// Mock Prisma factory
// ---------------------------------------------------------------------------

function createMockPrisma(rows: ReturnType<typeof makeRow>[]) {
  const updateFn = vi.fn().mockResolvedValue({});

  // Captures the callback passed to $transaction and runs it with a tx proxy
  // that delegates to updateFn — matching the interactive-transaction pattern
  // used by the real script.
  const transactionFn = vi.fn().mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      const tx = {
        templateQuestion: {
          update: updateFn,
        },
      };
      return callback(tx);
    }
    // Batch (array) form — not used by this script but guard anyway
    if (Array.isArray(callback)) return Promise.all(callback);
    return callback;
  });

  return {
    templateQuestion: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: updateFn,
    },
    $transaction: transactionFn,
    $disconnect: vi.fn(),
    _updateFn: updateFn,
    _transactionFn: transactionFn,
  };
}

function createDeps(
  rows: ReturnType<typeof makeRow>[],
  dryRun = false,
): MigrationDeps & { prisma: ReturnType<typeof createMockPrisma> } {
  const prisma = createMockPrisma(rows);
  return {
    prisma: prisma as any,
    dryRun,
    log: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// formatTriggersAsNotes (pure helper)
// ---------------------------------------------------------------------------

describe('formatTriggersAsNotes', () => {
  it('formats a single trigger under the heading', () => {
    expect(formatTriggersAsNotes(['mention promotion'])).toBe(
      'Legacy triggers:\n- mention promotion',
    );
  });

  it('formats multiple triggers as a bullet list', () => {
    expect(formatTriggersAsNotes(['trigger one', 'trigger two', 'trigger three'])).toBe(
      'Legacy triggers:\n- trigger one\n- trigger two\n- trigger three',
    );
  });
});

// ---------------------------------------------------------------------------
// runMigration — core behaviour
// ---------------------------------------------------------------------------

describe('runMigration', () => {
  // -----------------------------------------------------------------------
  // Migrates rows that have triggers but no adminNotes
  // -----------------------------------------------------------------------
  it('migrates trigger data into a bullet-list adminNotes value', async () => {
    const rows = [makeRow('row-1', ['ask follow-up', 'probe further'], null)];
    const deps = createDeps(rows);

    const summary = await runMigration(deps);

    expect(summary.migrated).toBe(1);
    expect(summary.skippedAlreadyPopulated).toBe(0);
    expect(summary.skippedNoTriggers).toBe(0);
    expect(summary.total).toBe(1);

    // Verify the transaction was called
    expect(deps.prisma._transactionFn).toHaveBeenCalledOnce();

    // Verify adminNotes content written
    expect(deps.prisma._updateFn).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { adminNotes: 'Legacy triggers:\n- ask follow-up\n- probe further' },
    });
  });

  // -----------------------------------------------------------------------
  // Preserves followupTriggers — update call must NOT touch it
  // -----------------------------------------------------------------------
  it('does not clear followupTriggers when writing adminNotes', async () => {
    const rows = [makeRow('row-1', ['some trigger'], null)];
    const deps = createDeps(rows);

    await runMigration(deps);

    const updateCall = deps.prisma._updateFn.mock.calls[0][0];
    // The data payload must not contain followupTriggers
    expect(updateCall.data).not.toHaveProperty('followupTriggers');
  });

  // -----------------------------------------------------------------------
  // Idempotent: second run is a no-op if adminNotes already set
  // -----------------------------------------------------------------------
  it('is idempotent — second run skips rows that already have adminNotes', async () => {
    // Simulate state after first migration: adminNotes already populated
    const rows = [
      makeRow('row-1', ['trigger a'], 'Legacy triggers:\n- trigger a'),
    ];
    const deps = createDeps(rows);

    const summary = await runMigration(deps);

    expect(summary.migrated).toBe(0);
    expect(summary.skippedAlreadyPopulated).toBe(1);
    expect(deps.prisma._transactionFn).not.toHaveBeenCalled();
    expect(deps.prisma._updateFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Skips rows with empty followupTriggers
  // -----------------------------------------------------------------------
  it('silently skips rows where followupTriggers is empty', async () => {
    const rows = [
      makeRow('row-empty-array', [], null),
      makeRow('row-null-triggers', null, null),
    ];
    const deps = createDeps(rows);

    const summary = await runMigration(deps);

    expect(summary.migrated).toBe(0);
    expect(summary.skippedNoTriggers).toBe(2);
    expect(summary.skippedAlreadyPopulated).toBe(0);
    expect(deps.prisma._transactionFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Skips rows with pre-existing adminNotes (non-empty string)
  // -----------------------------------------------------------------------
  it('skips rows that already have non-empty adminNotes, even if they have triggers', async () => {
    const rows = [
      makeRow('row-has-notes', ['trigger x'], 'Manually written guidance for this question.'),
    ];
    const deps = createDeps(rows);

    const summary = await runMigration(deps);

    expect(summary.skippedAlreadyPopulated).toBe(1);
    expect(summary.migrated).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Mixed batch: migrates some, skips others
  // -----------------------------------------------------------------------
  it('handles a mixed batch correctly', async () => {
    const rows = [
      makeRow('row-migrate', ['trigger one', 'trigger two'], null),
      makeRow('row-skip-notes', ['other trigger'], 'Existing admin note'),
      makeRow('row-skip-empty', [], null),
    ];
    const deps = createDeps(rows);

    const summary = await runMigration(deps);

    expect(summary.total).toBe(3);
    expect(summary.migrated).toBe(1);
    expect(summary.skippedAlreadyPopulated).toBe(1);
    expect(summary.skippedNoTriggers).toBe(1);

    // Only one update call, for the right row
    expect(deps.prisma._updateFn).toHaveBeenCalledOnce();
    expect(deps.prisma._updateFn.mock.calls[0][0].where.id).toBe('row-migrate');
  });

  // -----------------------------------------------------------------------
  // Dry-run flag: prints what would change without writing
  // -----------------------------------------------------------------------
  it('does not write when --dry-run is active', async () => {
    const rows = [makeRow('row-1', ['trigger a', 'trigger b'], null)];
    const deps = createDeps(rows, /* dryRun = */ true);

    const summary = await runMigration(deps);

    // Should still count the row as "would-migrate" in the summary
    expect(summary.migrated).toBe(1);

    // Must NOT call $transaction or update
    expect(deps.prisma._transactionFn).not.toHaveBeenCalled();
    expect(deps.prisma._updateFn).not.toHaveBeenCalled();
  });

  it('dry-run logs what would change for each pending row', async () => {
    const rows = [makeRow('row-1', ['probe further'], null)];
    const logFn = vi.fn();
    const deps: MigrationDeps = {
      prisma: createMockPrisma(rows) as any,
      dryRun: true,
      log: logFn,
    };

    await runMigration(deps);

    // At least one log call should mention the row id and the expected content
    const allLogs = logFn.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allLogs).toContain('row-1');
    expect(allLogs).toContain('Legacy triggers:');
    expect(allLogs).toContain('- probe further');
  });
});
