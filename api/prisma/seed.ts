import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

const prisma = new PrismaClient()

// ── Deterministic IDs for referencing in tests ──────────────────────────────

export const ADMIN_USER_ID = '00000000-0000-4000-a000-000000000001'
export const STANDARD_USER_ID = '00000000-0000-4000-a000-000000000002'

export const TAG_IDS = {
  engineering: '10000000-0000-4000-a000-000000000001',
  product: '10000000-0000-4000-a000-000000000002',
  senior: '10000000-0000-4000-a000-000000000003',
  leadership: '10000000-0000-4000-a000-000000000004',
  backend: '10000000-0000-4000-a000-000000000005',
} as const

export const QUESTION_IDS = {
  q1: '20000000-0000-4000-a000-000000000001',
  q2: '20000000-0000-4000-a000-000000000002',
  q3: '20000000-0000-4000-a000-000000000003',
  q4: '20000000-0000-4000-a000-000000000004',
  q5: '20000000-0000-4000-a000-000000000005',
  q6: '20000000-0000-4000-a000-000000000006',
  q7: '20000000-0000-4000-a000-000000000007',
  q8: '20000000-0000-4000-a000-000000000008',
  q9: '20000000-0000-4000-a000-000000000009',
  q10: '20000000-0000-4000-a000-000000000010',
} as const

export const TEMPLATE_ID = '30000000-0000-4000-a000-000000000001'

// ── Seed data definitions ───────────────────────────────────────────────────

const tags = [
  { id: TAG_IDS.engineering, label: 'Engineering', tagType: 'department' },
  { id: TAG_IDS.product, label: 'Product', tagType: 'department' },
  { id: TAG_IDS.senior, label: 'Senior', tagType: 'seniority' },
  { id: TAG_IDS.leadership, label: 'Leadership', tagType: 'role' },
  { id: TAG_IDS.backend, label: 'Backend', tagType: 'domain' },
]

const questions = [
  { id: QUESTION_IDS.q1, text: 'What motivated you to pursue your current career path?', category: 'motivation' },
  { id: QUESTION_IDS.q2, text: 'Describe a challenging project you led from start to finish.', category: 'experience' },
  { id: QUESTION_IDS.q3, text: 'How do you approach breaking down a complex technical problem?', category: 'process' },
  { id: QUESTION_IDS.q4, text: 'Tell me about a time you had to make a difficult trade-off decision.', category: 'challenge' },
  { id: QUESTION_IDS.q5, text: 'What is your opinion on the role of AI in software development?', category: 'opinion' },
  { id: QUESTION_IDS.q6, text: 'How do you handle disagreements within your team?', category: 'challenge' },
  { id: QUESTION_IDS.q7, text: 'Describe your ideal engineering culture.', category: 'opinion' },
  { id: QUESTION_IDS.q8, text: 'What process do you follow when reviewing code?', category: 'process' },
  { id: QUESTION_IDS.q9, text: 'Tell me about a failure that taught you an important lesson.', category: 'experience' },
  { id: QUESTION_IDS.q10, text: 'What keeps you motivated during long or difficult projects?', category: 'motivation' },
]

// Questions included in the template (6 of 10), with ordering and follow-up triggers
const templateQuestions = [
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q1,
    sequenceOrder: 1,
    categoryBucket: 'motivation',
    isRequired: true,
    followupTriggers: [],
  },
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q2,
    sequenceOrder: 2,
    categoryBucket: 'experience',
    isRequired: true,
    followupTriggers: [
      {
        id: randomUUID(),
        trigger_type: 'keyword',
        keywords: ['challenge', 'difficult', 'problem'],
        suggested_followup_question_ids: [QUESTION_IDS.q4],
        created_at: new Date().toISOString(),
      },
    ],
  },
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q3,
    sequenceOrder: 3,
    categoryBucket: 'process',
    isRequired: true,
    followupTriggers: [],
  },
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q4,
    sequenceOrder: 4,
    categoryBucket: 'challenge',
    isRequired: true,
    followupTriggers: [
      {
        id: randomUUID(),
        trigger_type: 'sentiment',
        sentiment: 'negative',
        suggested_followup_question_ids: [QUESTION_IDS.q6],
        created_at: new Date().toISOString(),
      },
    ],
  },
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q5,
    sequenceOrder: 5,
    categoryBucket: 'opinion',
    isRequired: false,
    followupTriggers: [],
  },
  {
    id: randomUUID(),
    questionId: QUESTION_IDS.q6,
    sequenceOrder: 6,
    categoryBucket: 'challenge',
    isRequired: true,
    followupTriggers: [
      {
        id: randomUUID(),
        trigger_type: 'length',
        length_condition: 'less_than_100_words',
        suggested_followup_question_ids: [QUESTION_IDS.q9],
        created_at: new Date().toISOString(),
      },
    ],
  },
]

// Question-tag associations
const questionTagAssociations = [
  { questionId: QUESTION_IDS.q1, tagId: TAG_IDS.engineering },
  { questionId: QUESTION_IDS.q1, tagId: TAG_IDS.product },
  { questionId: QUESTION_IDS.q2, tagId: TAG_IDS.senior },
  { questionId: QUESTION_IDS.q2, tagId: TAG_IDS.leadership },
  { questionId: QUESTION_IDS.q3, tagId: TAG_IDS.engineering },
  { questionId: QUESTION_IDS.q3, tagId: TAG_IDS.backend },
  { questionId: QUESTION_IDS.q4, tagId: TAG_IDS.leadership },
  { questionId: QUESTION_IDS.q5, tagId: TAG_IDS.engineering },
  { questionId: QUESTION_IDS.q6, tagId: TAG_IDS.leadership },
  { questionId: QUESTION_IDS.q7, tagId: TAG_IDS.product },
  { questionId: QUESTION_IDS.q8, tagId: TAG_IDS.engineering },
  { questionId: QUESTION_IDS.q8, tagId: TAG_IDS.backend },
  { questionId: QUESTION_IDS.q9, tagId: TAG_IDS.senior },
  { questionId: QUESTION_IDS.q10, tagId: TAG_IDS.engineering },
]

// ── Main seed function ──────────────────────────────────────────────────────

export async function seed() {
  // 1. Create users
  await prisma.user.createMany({
    data: [
      { id: ADMIN_USER_ID, name: 'Admin User', email: 'admin@elastichorizon.com', role: 'admin' },
      { id: STANDARD_USER_ID, name: 'Test Candidate', email: 'candidate@example.com', role: 'user' },
    ],
  })

  // 2. Create tags
  await prisma.tag.createMany({ data: tags })

  // 3. Create questions
  await prisma.question.createMany({ data: questions })

  // 4. Create question-tag associations
  await prisma.questionTag.createMany({ data: questionTagAssociations })

  // 5. Create template (published so it can be assigned)
  await prisma.interviewTemplate.create({
    data: {
      id: TEMPLATE_ID,
      name: 'Senior Engineer Interview',
      description: 'Standard interview template for senior engineering candidates.',
      status: 'published',
    },
  })

  // 6. Create template-question associations with ordering and triggers
  await prisma.templateQuestion.createMany({
    data: templateQuestions.map((tq) => ({
      id: tq.id,
      templateId: TEMPLATE_ID,
      questionId: tq.questionId,
      sequenceOrder: tq.sequenceOrder,
      categoryBucket: tq.categoryBucket,
      isRequired: tq.isRequired,
      followupTriggers: tq.followupTriggers,
    })),
  })

  // 7. Assign template to standard user (admin assigns)
  await prisma.userTemplate.create({
    data: {
      userId: STANDARD_USER_ID,
      templateId: TEMPLATE_ID,
      assignedBy: ADMIN_USER_ID,
      status: 'active',
    },
  })

  // 8. Create matching assignment history record
  await prisma.templateAssignmentHistory.create({
    data: {
      userId: STANDARD_USER_ID,
      templateId: TEMPLATE_ID,
      assignedBy: ADMIN_USER_ID,
    },
  })

  // 9. Assign tags to standard user
  await prisma.userTag.createMany({
    data: [
      { userId: STANDARD_USER_ID, tagId: TAG_IDS.engineering },
      { userId: STANDARD_USER_ID, tagId: TAG_IDS.senior },
    ],
  })

  console.log('Seed completed successfully.')
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
    .finally(async () => {
      await prisma.$disconnect()
    })
}
