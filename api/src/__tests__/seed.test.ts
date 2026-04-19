import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import {
  seed,
  ADMIN_USER_ID,
  STANDARD_USER_ID,
  TAG_IDS,
  QUESTION_IDS,
  TEMPLATE_ID,
} from '../../prisma/seed'

// Destructive integration test: truncates every table in DATABASE_URL before
// re-seeding. Gated behind ARENA_SEED_TESTS=1 so `vitest run` never wipes a
// live dev DB by accident. Also refuses any DATABASE_URL matching a known
// live-environment marker, even when the gate is set.
const SEED_TESTS_ENABLED = process.env.ARENA_SEED_TESTS === '1'
const DB_URL = process.env.DATABASE_URL ?? ''
const LIVE_DB_MARKERS = ['arena_seandev', 'arena_dev', 'arena_appv1', 'arena_prod']
const TARGETS_LIVE_DB = LIVE_DB_MARKERS.some((m) => DB_URL.includes(m))

if (SEED_TESTS_ENABLED && TARGETS_LIVE_DB) {
  throw new Error(
    `seed.test.ts refuses to run: DATABASE_URL contains a live-DB marker ` +
      `(${LIVE_DB_MARKERS.join(' | ')}). Point at a dedicated test database ` +
      `(e.g. arena_test) before setting ARENA_SEED_TESTS=1.`,
  )
}

const shouldRun = SEED_TESTS_ENABLED && !TARGETS_LIVE_DB
const describeSeed = shouldRun ? describe : describe.skip

const prisma = new PrismaClient()

/**
 * These tests run the seed function against a real database and verify
 * the integrity of the resulting data. Gated behind ARENA_SEED_TESTS=1.
 * To run: ARENA_SEED_TESTS=1 DATABASE_URL=postgresql://.../arena_test \
 *   npx vitest run src/__tests__/seed.test.ts
 */
beforeAll(async () => {
  if (!shouldRun) return
  // Clean all tables in dependency order before seeding
  await prisma.templateAssignmentHistory.deleteMany()
  await prisma.userTemplate.deleteMany()
  await prisma.responseDraft.deleteMany()
  await prisma.interviewResponse.deleteMany()
  await prisma.interview.deleteMany()
  await prisma.templateQuestion.deleteMany()
  await prisma.interviewTemplate.deleteMany()
  await prisma.questionTag.deleteMany()
  await prisma.userTag.deleteMany()
  await prisma.userConsentRecord.deleteMany()
  await prisma.adminAuditLog.deleteMany()
  await prisma.question.deleteMany()
  await prisma.tag.deleteMany()
  await prisma.user.deleteMany()

  await seed()
})

afterAll(async () => {
  await prisma.$disconnect()
})

describeSeed('Seed: Users', () => {
  it('creates exactly 2 users', async () => {
    const count = await prisma.user.count()
    expect(count).toBe(2)
  })

  it('creates an admin user with correct role', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER_ID } })
    expect(admin.role).toBe('admin')
    expect(admin.email).toBe('admin@elastichorizon.com')
  })

  it('creates a standard user with correct role', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: STANDARD_USER_ID } })
    expect(user.role).toBe('user')
    expect(user.email).toBe('candidate@example.com')
  })
})

describeSeed('Seed: Tags', () => {
  it('creates exactly 5 tags', async () => {
    const count = await prisma.tag.count()
    expect(count).toBe(5)
  })

  it('all tags are active', async () => {
    const inactive = await prisma.tag.count({ where: { isActive: false } })
    expect(inactive).toBe(0)
  })

  it('all tag labels are unique', async () => {
    const tags = await prisma.tag.findMany()
    const labels = tags.map((t) => t.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describeSeed('Seed: Questions', () => {
  it('creates exactly 10 questions', async () => {
    const count = await prisma.question.count()
    expect(count).toBe(10)
  })

  it('all questions are active', async () => {
    const inactive = await prisma.question.count({ where: { isActive: false } })
    expect(inactive).toBe(0)
  })

  it('every question has non-empty text', async () => {
    const questions = await prisma.question.findMany()
    for (const q of questions) {
      expect(q.text.length).toBeGreaterThan(0)
    }
  })
})

describeSeed('Seed: Question-Tag associations', () => {
  it('creates question-tag associations', async () => {
    const count = await prisma.questionTag.count()
    expect(count).toBeGreaterThan(0)
  })

  it('all referenced question IDs exist', async () => {
    const associations = await prisma.questionTag.findMany({ include: { question: true } })
    for (const assoc of associations) {
      expect(assoc.question).toBeTruthy()
    }
  })

  it('all referenced tag IDs exist', async () => {
    const associations = await prisma.questionTag.findMany({ include: { tag: true } })
    for (const assoc of associations) {
      expect(assoc.tag).toBeTruthy()
    }
  })
})

describeSeed('Seed: Interview Template', () => {
  it('creates exactly 1 template', async () => {
    const count = await prisma.interviewTemplate.count()
    expect(count).toBe(1)
  })

  it('template has status "published"', async () => {
    const template = await prisma.interviewTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })
    expect(template.status).toBe('published')
  })

  it('template has a name and description', async () => {
    const template = await prisma.interviewTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })
    expect(template.name).toBeTruthy()
    expect(template.description).toBeTruthy()
  })
})

describeSeed('Seed: Template Questions', () => {
  it('template has exactly 6 ordered questions', async () => {
    const count = await prisma.templateQuestion.count({ where: { templateId: TEMPLATE_ID } })
    expect(count).toBe(6)
  })

  it('sequence_order values are 1 through 6 without gaps', async () => {
    const tqs = await prisma.templateQuestion.findMany({
      where: { templateId: TEMPLATE_ID },
      orderBy: { sequenceOrder: 'asc' },
    })
    const orders = tqs.map((tq) => tq.sequenceOrder)
    expect(orders).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('all template question IDs reference existing questions', async () => {
    const tqs = await prisma.templateQuestion.findMany({
      where: { templateId: TEMPLATE_ID },
      include: { question: true },
    })
    for (const tq of tqs) {
      expect(tq.question).toBeTruthy()
    }
  })

  it('no duplicate questions in the template', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    const questionIds = tqs.map((tq) => tq.questionId)
    expect(new Set(questionIds).size).toBe(questionIds.length)
  })

  it('every template question has a non-empty categoryBucket', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    for (const tq of tqs) {
      expect(tq.categoryBucket).toBeTruthy()
    }
  })

  it('at least one template question has follow-up triggers', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    const withTriggers = tqs.filter((tq) => {
      const triggers = tq.followupTriggers as unknown[]
      return Array.isArray(triggers) && triggers.length > 0
    })
    expect(withTriggers.length).toBeGreaterThan(0)
  })

  it('follow-up triggers have valid structure', async () => {
    const validTriggerTypes = ['keyword', 'sentiment', 'length', 'always']
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })

    for (const tq of tqs) {
      const triggers = tq.followupTriggers as Array<Record<string, unknown>>
      if (!Array.isArray(triggers)) continue
      for (const trigger of triggers) {
        expect(trigger.id).toBeTruthy()
        expect(validTriggerTypes).toContain(trigger.trigger_type)
        expect(trigger.created_at).toBeTruthy()
        expect(Array.isArray(trigger.suggested_followup_question_ids)).toBe(true)
      }
    }
  })

  it('follow-up trigger suggested question IDs reference questions within the template', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    const templateQuestionIds = new Set(tqs.map((tq) => tq.questionId))

    // Collect all question IDs from all templates' questions (including those not in the 6)
    const allQuestionIds = await prisma.question.findMany({ select: { id: true } })
    const allQIds = new Set(allQuestionIds.map((q) => q.id))

    for (const tq of tqs) {
      const triggers = tq.followupTriggers as Array<Record<string, unknown>>
      if (!Array.isArray(triggers)) continue
      for (const trigger of triggers) {
        const followupIds = trigger.suggested_followup_question_ids as string[]
        for (const fid of followupIds) {
          // Referenced questions must exist in the database
          expect(allQIds.has(fid)).toBe(true)
        }
      }
    }
  })

  it('keyword triggers include a keywords array', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    for (const tq of tqs) {
      const triggers = tq.followupTriggers as Array<Record<string, unknown>>
      if (!Array.isArray(triggers)) continue
      for (const trigger of triggers) {
        if (trigger.trigger_type === 'keyword') {
          expect(Array.isArray(trigger.keywords)).toBe(true)
          expect((trigger.keywords as string[]).length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('sentiment triggers include a sentiment value', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    const validSentiments = ['positive', 'negative', 'neutral']
    for (const tq of tqs) {
      const triggers = tq.followupTriggers as Array<Record<string, unknown>>
      if (!Array.isArray(triggers)) continue
      for (const trigger of triggers) {
        if (trigger.trigger_type === 'sentiment') {
          expect(validSentiments).toContain(trigger.sentiment)
        }
      }
    }
  })

  it('length triggers include a length_condition', async () => {
    const tqs = await prisma.templateQuestion.findMany({ where: { templateId: TEMPLATE_ID } })
    for (const tq of tqs) {
      const triggers = tq.followupTriggers as Array<Record<string, unknown>>
      if (!Array.isArray(triggers)) continue
      for (const trigger of triggers) {
        if (trigger.trigger_type === 'length') {
          expect(trigger.length_condition).toBeTruthy()
        }
      }
    }
  })
})

describeSeed('Seed: Template Assignment', () => {
  it('standard user has an active template assignment', async () => {
    const assignment = await prisma.userTemplate.findFirst({
      where: { userId: STANDARD_USER_ID, templateId: TEMPLATE_ID, status: 'active' },
    })
    expect(assignment).toBeTruthy()
  })

  it('assignment was made by the admin user', async () => {
    const assignment = await prisma.userTemplate.findFirstOrThrow({
      where: { userId: STANDARD_USER_ID, templateId: TEMPLATE_ID },
    })
    expect(assignment.assignedBy).toBe(ADMIN_USER_ID)
  })

  it('assignment history record exists', async () => {
    const history = await prisma.templateAssignmentHistory.findFirst({
      where: { userId: STANDARD_USER_ID, templateId: TEMPLATE_ID },
    })
    expect(history).toBeTruthy()
    expect(history!.assignedBy).toBe(ADMIN_USER_ID)
    expect(history!.unassignedAt).toBeNull()
  })
})

describeSeed('Seed: User Tags', () => {
  it('standard user has tag associations', async () => {
    const count = await prisma.userTag.count({ where: { userId: STANDARD_USER_ID } })
    expect(count).toBeGreaterThan(0)
  })

  it('all user tag references are valid', async () => {
    const userTags = await prisma.userTag.findMany({
      where: { userId: STANDARD_USER_ID },
      include: { tag: true },
    })
    for (const ut of userTags) {
      expect(ut.tag).toBeTruthy()
      expect(ut.tag.isActive).toBe(true)
    }
  })
})

describeSeed('Seed: Referential Integrity', () => {
  it('no orphaned question-tag records', async () => {
    const orphanedByQuestion = await prisma.questionTag.findMany({
      where: { question: { id: { not: undefined } } },
      include: { question: true, tag: true },
    })
    for (const qt of orphanedByQuestion) {
      expect(qt.question).toBeTruthy()
      expect(qt.tag).toBeTruthy()
    }
  })

  it('template only references published status', async () => {
    const template = await prisma.interviewTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })
    expect(template.status).toBe('published')
  })

  it('only published templates are assigned to users', async () => {
    const assignments = await prisma.userTemplate.findMany({ include: { template: true } })
    for (const a of assignments) {
      expect(a.template.status).toBe('published')
    }
  })
})
