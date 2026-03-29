// ---------------------------------------------------------------------------
// Arena DataLoaders — Batched resolution for N+1 prevention
// ---------------------------------------------------------------------------

import DataLoader from 'dataloader';
import type { PrismaClient, Tag, Question, InterviewResponse } from '@prisma/client';

// ---------------------------------------------------------------------------
// Tag DataLoaders
// ---------------------------------------------------------------------------

/**
 * Batch-loads tags by their IDs.
 * Used when resolving `Question.tags` or `User.tags` across a list.
 */
export function createTagByIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Tag | null>(async (ids) => {
    const tags = await prisma.tag.findMany({
      where: { id: { in: [...ids] } },
    });
    const tagMap = new Map(tags.map((t) => [t.id, t]));
    return ids.map((id) => tagMap.get(id) ?? null);
  });
}

/**
 * Batch-loads tags for a set of question IDs via the question_tags junction.
 * Returns Tag[] per question.
 */
export function createTagsByQuestionIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Tag[]>(async (questionIds) => {
    const questionTags = await prisma.questionTag.findMany({
      where: { questionId: { in: [...questionIds] } },
      include: { tag: true },
    });
    const map = new Map<string, Tag[]>();
    for (const qt of questionTags) {
      const existing = map.get(qt.questionId) ?? [];
      existing.push(qt.tag);
      map.set(qt.questionId, existing);
    }
    return questionIds.map((id) => map.get(id) ?? []);
  });
}

/**
 * Batch-loads tags for a set of user IDs via the user_tags junction.
 * Returns Tag[] per user.
 */
export function createTagsByUserIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Tag[]>(async (userIds) => {
    const userTags = await prisma.userTag.findMany({
      where: { userId: { in: [...userIds] } },
      include: { tag: true },
    });
    const map = new Map<string, Tag[]>();
    for (const ut of userTags) {
      const existing = map.get(ut.userId) ?? [];
      existing.push(ut.tag);
      map.set(ut.userId, existing);
    }
    return userIds.map((id) => map.get(id) ?? []);
  });
}

// ---------------------------------------------------------------------------
// Question DataLoaders
// ---------------------------------------------------------------------------

/**
 * Batch-loads questions by their IDs.
 * Used when resolving `TemplateQuestion.question` across a list.
 */
export function createQuestionByIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Question | null>(async (ids) => {
    const questions = await prisma.question.findMany({
      where: { id: { in: [...ids] } },
    });
    const map = new Map(questions.map((q) => [q.id, q]));
    return ids.map((id) => map.get(id) ?? null);
  });
}

// ---------------------------------------------------------------------------
// Response DataLoaders
// ---------------------------------------------------------------------------

/**
 * Batch-loads interview responses by interview ID.
 * Returns InterviewResponse[] per interview, ordered by sequence number.
 */
export function createResponsesByInterviewIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, InterviewResponse[]>(async (interviewIds) => {
    const responses = await prisma.interviewResponse.findMany({
      where: { interviewId: { in: [...interviewIds] } },
      orderBy: { sequenceNumber: 'asc' },
    });
    const map = new Map<string, InterviewResponse[]>();
    for (const r of responses) {
      const existing = map.get(r.interviewId) ?? [];
      existing.push(r);
      map.set(r.interviewId, existing);
    }
    return interviewIds.map((id) => map.get(id) ?? []);
  });
}

/**
 * Batch-loads a single interview response by ID.
 */
export function createResponseByIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, InterviewResponse | null>(async (ids) => {
    const responses = await prisma.interviewResponse.findMany({
      where: { id: { in: [...ids] } },
    });
    const map = new Map(responses.map((r) => [r.id, r]));
    return ids.map((id) => map.get(id) ?? null);
  });
}

// ---------------------------------------------------------------------------
// User DataLoader
// ---------------------------------------------------------------------------

/**
 * Batch-loads users by their IDs.
 * Used when resolving `Interview.user` or `AuditLogEntry.actorName`.
 */
export function createUserByIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, { id: string; name: string; email: string; role: string } | null>(
    async (ids) => {
      const users = await prisma.user.findMany({
        where: { id: { in: [...ids] } },
      });
      const map = new Map(users.map((u) => [u.id, u]));
      return ids.map((id) => map.get(id) ?? null);
    },
  );
}

// ---------------------------------------------------------------------------
// InterviewTemplate DataLoader
// ---------------------------------------------------------------------------

/**
 * Batch-loads interview templates by their IDs.
 * Used when resolving `Interview.template` or `UserTemplateAssignment.template`.
 */
export function createTemplateByIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, { id: string; name: string; description: string | null; systemPrompt: string | null; status: string } | null>(
    async (ids) => {
      const templates = await prisma.interviewTemplate.findMany({
        where: { id: { in: [...ids] } },
      });
      const map = new Map(templates.map((t) => [t.id, t]));
      return ids.map((id) => map.get(id) ?? null);
    },
  );
}

// ---------------------------------------------------------------------------
// TemplateQuestion DataLoader
// ---------------------------------------------------------------------------

/**
 * Batch-loads template questions by template ID, ordered by sequence.
 * Used when resolving `InterviewTemplate.questions`.
 */
export function createTemplateQuestionsByTemplateIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Array<{
    id: string;
    questionId: string;
    sequenceOrder: number;
    categoryBucket: string;
    isRequired: boolean;
    followupTriggers: unknown;
  }>>(async (templateIds) => {
    const tqs = await prisma.templateQuestion.findMany({
      where: { templateId: { in: [...templateIds] } },
      orderBy: { sequenceOrder: 'asc' },
    });
    const map = new Map<string, typeof tqs>();
    for (const tq of tqs) {
      const existing = map.get(tq.templateId) ?? [];
      existing.push(tq);
      map.set(tq.templateId, existing);
    }
    return templateIds.map((id) => map.get(id) ?? []);
  });
}

// ---------------------------------------------------------------------------
// Consent Status DataLoader
// ---------------------------------------------------------------------------

/**
 * Batch-loads consent status for a set of user IDs.
 * Returns ConsentStatus per user (computed from user_consent_records).
 */
export interface ConsentStatusResult {
  dataProcessing: boolean;
  audioRecording: boolean;
  aiInteraction: boolean;
  allGranted: boolean;
}

export function createConsentStatusByUserIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, ConsentStatusResult>(async (userIds) => {
    const records = await prisma.userConsentRecord.findMany({
      where: {
        userId: { in: [...userIds] },
        revokedAt: null,
      },
    });
    const map = new Map<string, Set<string>>();
    for (const r of records) {
      const existing = map.get(r.userId) ?? new Set();
      existing.add(r.consentType);
      map.set(r.userId, existing);
    }
    return userIds.map((id) => {
      const types = map.get(id) ?? new Set();
      const dataProcessing = types.has('data_processing');
      const audioRecording = types.has('audio_recording');
      const aiInteraction = types.has('ai_interaction');
      return {
        dataProcessing,
        audioRecording,
        aiInteraction,
        allGranted: dataProcessing && audioRecording && aiInteraction,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// UserTemplateAssignment DataLoader
// ---------------------------------------------------------------------------

/**
 * Batch-loads active template assignments for a set of user IDs.
 * Used when resolving `User.assignedTemplates`.
 */
export function createAssignmentsByUserIdLoader(prisma: PrismaClient) {
  return new DataLoader<string, Array<{
    id: string;
    templateId: string;
    assignedAt: Date;
    assignedBy: string;
    status: string;
    completedAt: Date | null;
  }>>(async (userIds) => {
    const assignments = await prisma.userTemplate.findMany({
      where: {
        userId: { in: [...userIds] },
        status: 'active',
      },
    });
    const map = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const existing = map.get(a.userId) ?? [];
      existing.push(a);
      map.set(a.userId, existing);
    }
    return userIds.map((id) => map.get(id) ?? []);
  });
}

// ---------------------------------------------------------------------------
// Factory — creates all loaders for a single request
// ---------------------------------------------------------------------------

export interface ArenaDataLoaders {
  tagById: ReturnType<typeof createTagByIdLoader>;
  tagsByQuestionId: ReturnType<typeof createTagsByQuestionIdLoader>;
  tagsByUserId: ReturnType<typeof createTagsByUserIdLoader>;
  questionById: ReturnType<typeof createQuestionByIdLoader>;
  responsesByInterviewId: ReturnType<typeof createResponsesByInterviewIdLoader>;
  responseById: ReturnType<typeof createResponseByIdLoader>;
  userById: ReturnType<typeof createUserByIdLoader>;
  templateById: ReturnType<typeof createTemplateByIdLoader>;
  templateQuestionsByTemplateId: ReturnType<typeof createTemplateQuestionsByTemplateIdLoader>;
  consentStatusByUserId: ReturnType<typeof createConsentStatusByUserIdLoader>;
  assignmentsByUserId: ReturnType<typeof createAssignmentsByUserIdLoader>;
}

export function createDataLoaders(prisma: PrismaClient): ArenaDataLoaders {
  return {
    tagById: createTagByIdLoader(prisma),
    tagsByQuestionId: createTagsByQuestionIdLoader(prisma),
    tagsByUserId: createTagsByUserIdLoader(prisma),
    questionById: createQuestionByIdLoader(prisma),
    responsesByInterviewId: createResponsesByInterviewIdLoader(prisma),
    responseById: createResponseByIdLoader(prisma),
    userById: createUserByIdLoader(prisma),
    templateById: createTemplateByIdLoader(prisma),
    templateQuestionsByTemplateId: createTemplateQuestionsByTemplateIdLoader(prisma),
    consentStatusByUserId: createConsentStatusByUserIdLoader(prisma),
    assignmentsByUserId: createAssignmentsByUserIdLoader(prisma),
  };
}
