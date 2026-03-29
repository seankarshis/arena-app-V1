import { PrismaClient } from '@prisma/client'
import { seed as seedProvenance } from './seed-provenance'

const prisma = new PrismaClient()

// ── Deterministic IDs for referencing in tests ──────────────────────────────

export const ADMIN_USER_ID = '00000000-0000-4000-a000-000000000001'
export const STANDARD_USER_ID = '00000000-0000-4000-a000-000000000002'

// ── Main seed function ──────────────────────────────────────────────────────

export async function seed() {
  // 1. Upsert users
  await prisma.user.upsert({
    where: { id: ADMIN_USER_ID },
    update: { name: 'Admin User', email: 'admin@elastichorizon.com', role: 'admin' },
    create: { id: ADMIN_USER_ID, name: 'Admin User', email: 'admin@elastichorizon.com', role: 'admin' },
  })
  await prisma.user.upsert({
    where: { id: STANDARD_USER_ID },
    update: { name: 'Client', email: 'client@client.com', role: 'user' },
    create: { id: STANDARD_USER_ID, name: 'Client', email: 'client@client.com', role: 'user' },
  })
  console.log('Users seeded.')

  // 2. Seed Provenance M&A content (tags, questions, templates)
  await seedProvenance()

  await prisma.$disconnect()
}

// Run when executed directly (not when imported by tests)
const isMainModule =
  typeof require !== 'undefined' && require.main === module

if (isMainModule) {
  seed()
    .catch((e) => {
      console.error('Seed failed:', e)
      process.exit(1)
    })
}
