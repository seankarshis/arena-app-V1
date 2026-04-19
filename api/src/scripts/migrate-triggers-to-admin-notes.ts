// ---------------------------------------------------------------------------
// migrate-triggers-to-admin-notes.ts
//
// One-shot data migration: moves legacy `followupTriggers` content on
// TemplateQuestion rows into the new `adminNotes` field introduced in
// Phase 3 of the interview-bot transformation (ADR 008).
//
// Usage:
//   npx tsx api/src/scripts/migrate-triggers-to-admin-notes.ts [--dry-run]
//
// Idempotent: rows that already have adminNotes are skipped. Rows with
// empty followupTriggers are skipped silently. followupTriggers is NOT
// cleared — preserved for rollback until the column is formally dropped.
// ---------------------------------------------------------------------------

import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MigrationSummary {
  migrated: number;
  skippedAlreadyPopulated: number;
  skippedNoTriggers: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse followupTriggers from the raw JSONB value Prisma returns.
 * The schema default is `[]`, so we guard against null/non-array values
 * defensively.
 */
function parseTriggers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * Format an array of trigger strings into the adminNotes bullet-list format.
 */
export function formatTriggersAsNotes(triggers: string[]): string {
  const bullets = triggers.map((t) => `- ${t}`).join('\n');
  return `Legacy triggers:\n${bullets}`;
}

// ---------------------------------------------------------------------------
// Core migration logic (accepts injected Prisma client for testability)
// ---------------------------------------------------------------------------

export interface MigrationDeps {
  prisma: PrismaClient;
  dryRun: boolean;
  log: (msg: string) => void;
}

export async function runMigration(deps: MigrationDeps): Promise<MigrationSummary> {
  const { prisma, dryRun, log } = deps;

  // Fetch all TemplateQuestion rows
  const rows = await prisma.templateQuestion.findMany({
    select: {
      id: true,
      followupTriggers: true,
      adminNotes: true,
    },
  });

  const summary: MigrationSummary = {
    migrated: 0,
    skippedAlreadyPopulated: 0,
    skippedNoTriggers: 0,
    total: rows.length,
  };

  // Classify rows
  const toMigrate: { id: string; newAdminNotes: string }[] = [];

  for (const row of rows) {
    const triggers = parseTriggers(row.followupTriggers);
    const hasExistingNotes = typeof row.adminNotes === 'string' && row.adminNotes.trim() !== '';

    if (hasExistingNotes) {
      log(`[skip] ${row.id} — skipped (already has admin notes)`);
      summary.skippedAlreadyPopulated++;
      continue;
    }

    if (triggers.length === 0) {
      summary.skippedNoTriggers++;
      continue;
    }

    // Needs migration
    const newAdminNotes = formatTriggersAsNotes(triggers);
    toMigrate.push({ id: row.id, newAdminNotes });
  }

  if (toMigrate.length === 0) {
    log('[info] No rows require migration.');
    summary.migrated = 0;
    return summary;
  }

  if (dryRun) {
    log(`[dry-run] Would migrate ${toMigrate.length} row(s):`);
    for (const item of toMigrate) {
      log(`  [dry-run] ${item.id} → adminNotes:\n${item.newAdminNotes}`);
    }
    summary.migrated = toMigrate.length;
    return summary;
  }

  // Wrap all writes in a single transaction (atomic)
  await prisma.$transaction(async (tx) => {
    for (const item of toMigrate) {
      await tx.templateQuestion.update({
        where: { id: item.id },
        data: { adminNotes: item.newAdminNotes },
      });
      log(`[migrated] ${item.id}`);
    }
  });

  summary.migrated = toMigrate.length;
  return summary;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('[migrate-triggers-to-admin-notes] DRY RUN — no writes will occur.');
  } else {
    console.log('[migrate-triggers-to-admin-notes] Starting migration...');
  }

  const prisma = new PrismaClient();

  try {
    const summary = await runMigration({
      prisma,
      dryRun,
      log: (msg) => console.log(msg),
    });

    console.log('\n[migrate-triggers-to-admin-notes] Summary:', JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[migrate-triggers-to-admin-notes] Fatal error:', err);
  process.exit(1);
});
