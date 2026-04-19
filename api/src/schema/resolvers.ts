// ---------------------------------------------------------------------------
// Arena GraphQL Resolvers — All CRUD Queries and Mutations
// ---------------------------------------------------------------------------

import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import type { ArenaContext } from './context';
import type { AuthUser } from '../middleware/auth';
import {
  notFound,
  duplicateEntry,
  invalidState,
  unauthorized,
  forbidden,
  internalError,
  externalServiceError,
  validationError,
} from '../middleware/errors';
import {
  startInterview as startInterviewService,
  abandonInterview as abandonInterviewService,
  pauseInterview as pauseInterviewService,
  resumeInterview as resumeInterviewService,
} from '../services/interviewSession';
import {
  submitResponse as submitResponseService,
  skipQuestion as skipQuestionService,
  completeInterview as completeInterviewService,
  createClaudeApiClient,
  createClaudeStreamingClient,
  createEventPublisher,
} from '../services/interviewEngine';
import { saveDraft as saveDraftService } from '../services/draftService';
import { pushTurnToSSE } from '../sse/stream';
import { getRedisClient } from '../services/redis';
import type { InterviewSessionState } from '../services/sessionState';

function getClaudeClient() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw internalError('CLAUDE_API_KEY is not configured');
  return createClaudeApiClient(apiKey);
}

function getStreamingClaudeClient() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw internalError('CLAUDE_API_KEY is not configured');
  return createClaudeStreamingClient(apiKey);
}

// ---------------------------------------------------------------------------
// JSON Scalar
// ---------------------------------------------------------------------------

function parseJsonLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return parseInt(ast.value, 10);
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((f) => [f.name.value, parseJsonLiteral(f.value)]),
      );
    case Kind.LIST:
      return ast.values.map(parseJsonLiteral);
    case Kind.NULL:
      return null;
    default:
      return null;
  }
}

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseJsonLiteral,
});

// ---------------------------------------------------------------------------
// Auth Helpers
// ---------------------------------------------------------------------------

function requireAuth(ctx: ArenaContext): AuthUser {
  if (!ctx.user) throw unauthorized('Authentication required');
  return ctx.user;
}

function requireAdmin(ctx: ArenaContext): AuthUser {
  const user = requireAuth(ctx);
  if (!user.groups.includes('admin')) throw forbidden('Admin access required');
  return user;
}

// ---------------------------------------------------------------------------
// Pagination Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf8');
}

function clampPageSize(first?: number | null): number {
  return Math.max(1, Math.min(first ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginate<T extends { id: string }>(
  findMany: (args: any) => Promise<T[]>,
  count: (args: any) => Promise<number>,
  where: Record<string, unknown>,
  pagination: { first?: number | null; after?: string | null },
  orderBy: Record<string, string> | Array<Record<string, string>> = [
    { createdAt: 'desc' },
    { id: 'desc' },
  ],
) {
  const take = clampPageSize(pagination.first);
  const findArgs: Record<string, unknown> = { where, take: take + 1, orderBy };

  if (pagination.after) {
    findArgs.cursor = { id: decodeCursor(pagination.after) };
    findArgs.skip = 1;
  }

  const [items, totalCount] = await Promise.all([
    findMany(findArgs),
    count({ where }),
  ]);

  const hasNextPage = items.length > take;
  const nodes = hasNextPage ? items.slice(0, take) : items;

  return {
    edges: nodes.map((item) => ({ cursor: encodeCursor(item.id), node: item })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: !!pagination.after,
      startCursor: nodes.length > 0 ? encodeCursor(nodes[0].id) : null,
      endCursor: nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1].id) : null,
    },
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// Utility: derive FlaggedItemStatus from Prisma fields
// ---------------------------------------------------------------------------

type FlaggedItemRow = {
  id: string;
  interviewId: string;
  sourceTurn: number;
  priority: string;
  description: string;
  suggestedTags: unknown;
  needsAdminReview: boolean;
  dismissedAt: Date | null;
  convertedToQuestionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function deriveFlaggedItemStatus(row: FlaggedItemRow): string {
  if (row.dismissedAt) return 'dismissed';
  if (row.convertedToQuestionId) return 'resolved';
  if (!row.needsAdminReview) return 'reviewed';
  return 'pending';
}

function mapFlaggedItem(row: FlaggedItemRow) {
  const suggestedTags = Array.isArray(row.suggestedTags) ? row.suggestedTags as string[] : [];
  return {
    id: row.id,
    interviewId: row.interviewId,
    sourceTurn: row.sourceTurn,
    priority: row.priority.toLowerCase(),
    description: row.description,
    suggestedTags,
    status: deriveFlaggedItemStatus(row),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    reviewedAt: row.updatedAt && !row.needsAdminReview
      ? (row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt)
      : null,
    reviewedBy: null, // not stored in this Prisma model
  };
}

function mapFlaggedItemStatusToWhere(status: string | null | undefined): Record<string, unknown> {
  if (!status) return {};
  switch (status) {
    case 'dismissed':
      return { dismissedAt: { not: null } };
    case 'resolved':
      return { convertedToQuestionId: { not: null }, dismissedAt: null };
    case 'reviewed':
      return { needsAdminReview: false, dismissedAt: null, convertedToQuestionId: null };
    case 'pending':
      return { needsAdminReview: true, dismissedAt: null, convertedToQuestionId: null };
    default:
      return {};
  }
}

function mapFlaggedItemPriorityToWhere(priority: string | null | undefined): Record<string, unknown> {
  if (!priority) return {};
  // Prisma enum is uppercase (LOW, MEDIUM, HIGH, CRITICAL), schema maps to lowercase
  return { priority: priority.toUpperCase() };
}

function sessionRedisKey(interviewId: string): string {
  return `interview:session:${interviewId}`;
}

// ---------------------------------------------------------------------------
// Utility: check if a questionId is referenced in follow-up triggers
// ---------------------------------------------------------------------------

function isQuestionReferencedInTriggers(questionId: string, triggers: unknown): boolean {
  if (!Array.isArray(triggers)) return false;
  return triggers.some((trigger) => {
    if (typeof trigger !== 'object' || trigger === null) return false;
    const t = trigger as Record<string, unknown>;
    if (Array.isArray(t.suggested_followup_question_ids)) {
      return (t.suggested_followup_question_ids as string[]).includes(questionId);
    }
    return t.questionId === questionId;
  });
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const resolvers = {
  JSON: JSONScalar,

  // =========================================================================
  // Queries
  // =========================================================================
  Query: {
    _health: () => 'ok',

    // --- Tags (not paginated) ---
    async getTags(
      _parent: unknown,
      args: { includeInactive?: boolean | null },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const where: Record<string, unknown> = {};
      if (!args.includeInactive) where.isActive = true;
      return ctx.prisma.tag.findMany({ where, orderBy: { label: 'asc' } });
    },

    // --- Questions (paginated) ---
    async getQuestions(
      _parent: unknown,
      args: {
        filters?: { tagIds?: string[]; searchText?: string } | null;
        includeInactive?: boolean | null;
        first?: number | null;
        after?: string | null;
      },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const where: Record<string, unknown> = {};
      if (!args.includeInactive) where.isActive = true;
      if (args.filters?.searchText) {
        where.text = { contains: args.filters.searchText, mode: 'insensitive' };
      }
      if (args.filters?.tagIds && args.filters.tagIds.length > 0) {
        where.questionTags = { some: { tagId: { in: args.filters.tagIds } } };
      }
      return paginate(
        (a) => ctx.prisma.question.findMany(a),
        (a) => ctx.prisma.question.count(a),
        where,
        { first: args.first, after: args.after },
      );
    },

    // --- User ---
    async getUser(_parent: unknown, args: { id: string }, ctx: ArenaContext) {
      requireAuth(ctx);
      return ctx.prisma.user.findUnique({ where: { id: args.id } });
    },

    // --- My Assigned Templates ---
    async getMyAssignedTemplates(_parent: unknown, _args: unknown, ctx: ArenaContext) {
      const user = requireAuth(ctx);
      const assignments = await ctx.prisma.userTemplate.findMany({
        where: { userId: user.userId, status: 'active' },
      });
      if (assignments.length === 0) return [];

      const interviews = await ctx.prisma.interview.findMany({
        where: {
          userId: user.userId,
          templateId: { in: assignments.map((a: { templateId: string }) => a.templateId) },
        },
        orderBy: { createdAt: 'desc' },
      });

      const interviewByTemplate = new Map<string, { status: string }>();
      for (const i of interviews) {
        if (!interviewByTemplate.has(i.templateId)) {
          interviewByTemplate.set(i.templateId, i);
        }
      }

      return assignments.map((assignment: { templateId: string }) => ({
        assignment,
        interviewStatus: interviewByTemplate.get(assignment.templateId)?.status ?? null,
      }));
    },

    // --- Interview ---
    async getInterview(_parent: unknown, args: { id: string }, ctx: ArenaContext) {
      requireAuth(ctx);
      return ctx.prisma.interview.findUnique({ where: { id: args.id } });
    },

    // --- Interviews by User (paginated) ---
    async getInterviewsByUser(
      _parent: unknown,
      args: { userId: string; first?: number | null; after?: string | null },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      return paginate(
        (a) => ctx.prisma.interview.findMany(a),
        (a) => ctx.prisma.interview.count(a),
        { userId: args.userId },
        { first: args.first, after: args.after },
      );
    },

    // --- Template ---
    async getTemplate(_parent: unknown, args: { id: string }, ctx: ArenaContext) {
      requireAuth(ctx);
      return ctx.prisma.interviewTemplate.findUnique({ where: { id: args.id } });
    },

    // --- Templates (not paginated) ---
    async getTemplates(
      _parent: unknown,
      args: { status?: string | null },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const where: Record<string, unknown> = {};
      if (args.status) where.status = args.status;
      return ctx.prisma.interviewTemplate.findMany({ where, orderBy: { name: 'asc' } });
    },

    // --- Single Interview Response ---
    async getInterviewResponse(_parent: unknown, args: { id: string }, ctx: ArenaContext) {
      requireAuth(ctx);
      return ctx.prisma.interviewResponse.findUnique({ where: { id: args.id } });
    },

    // --- Drafts for Response (paginated, admin only) ---
    async getDraftsForResponse(
      _parent: unknown,
      args: {
        interviewId: string;
        questionId: string;
        first?: number | null;
        after?: string | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      return paginate(
        (a) => ctx.prisma.responseDraft.findMany(a),
        (a) => ctx.prisma.responseDraft.count(a),
        { interviewId: args.interviewId, questionId: args.questionId },
        { first: args.first, after: args.after },
      );
    },

    // --- Template Assignment History (paginated, admin only) ---
    async getTemplateAssignmentHistory(
      _parent: unknown,
      args: { userId: string; first?: number | null; after?: string | null },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      return paginate(
        (a) => ctx.prisma.templateAssignmentHistory.findMany(a),
        (a) => ctx.prisma.templateAssignmentHistory.count(a),
        { userId: args.userId },
        { first: args.first, after: args.after },
      );
    },

    // --- My Consent Status ---
    async getMyConsentStatus(_parent: unknown, _args: unknown, ctx: ArenaContext) {
      const user = requireAuth(ctx);
      return ctx.loaders.consentStatusByUserId.load(user.userId);
    },

    // --- Audit Log (paginated, admin only) ---
    async getAuditLog(
      _parent: unknown,
      args: {
        entityType?: string | null;
        entityId?: string | null;
        actorId?: string | null;
        first?: number | null;
        after?: string | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const where: Record<string, unknown> = {};
      if (args.entityType) where.entityType = args.entityType;
      if (args.entityId) where.entityId = args.entityId;
      if (args.actorId) where.actorId = args.actorId;
      return paginate(
        (a) => ctx.prisma.adminAuditLog.findMany(a),
        (a) => ctx.prisma.adminAuditLog.count(a),
        where,
        { first: args.first, after: args.after },
      );
    },

    // --- List all users (admin only, not paginated) ---
    async listUsers(_parent: unknown, _args: unknown, ctx: ArenaContext) {
      requireAdmin(ctx);
      return ctx.prisma.user.findMany({ orderBy: { name: 'asc' } });
    },

    // --- List all interviews (admin only, paginated) ---
    async listAllInterviews(
      _parent: unknown,
      args: { status?: string | null; first?: number | null; after?: string | null },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const where: Record<string, unknown> = {};
      if (args.status) where.status = args.status;
      return paginate(
        (a) => ctx.prisma.interview.findMany(a),
        (a) => ctx.prisma.interview.count(a),
        where,
        { first: args.first, after: args.after },
      );
    },

    // --- Flagged items (admin only) ---
    async flaggedItems(
      _parent: unknown,
      args: {
        status?: string | null;
        priority?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const where: Record<string, unknown> = {
        ...mapFlaggedItemStatusToWhere(args.status),
        ...mapFlaggedItemPriorityToWhere(args.priority),
      };
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (ctx.prisma as any).flaggedItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
      return (rows as FlaggedItemRow[]).map(mapFlaggedItem);
    },

    async flaggedItem(
      _parent: unknown,
      args: { id: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (ctx.prisma as any).flaggedItem.findUnique({ where: { id: args.id } });
      if (!row) return null;
      return mapFlaggedItem(row as FlaggedItemRow);
    },

    // --- Tag merge proposals (admin only) ---
    async tagMergeProposals(
      _parent: unknown,
      args: {
        status?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const where: Record<string, unknown> = {};
      if (args.status) where.status = args.status.toUpperCase();
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (ctx.prisma as any).tagMergeProposal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
      return rows;
    },

    // --- Coverage map (admin only) ---
    async coverageMap(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);

      const interview = await ctx.prisma.interview.findUnique({ where: { id: args.interviewId } });
      if (!interview) return null;

      try {
        const redis = getRedisClient();
        const raw = await redis.get(sessionRedisKey(args.interviewId));
        if (!raw) return null;

        const session = JSON.parse(raw) as InterviewSessionState;
        if (session.sessionVersion !== 'v2-coverage') return null;

        const entries = Object.entries(session.coverage).map(([questionId, entry]) => ({
          questionId,
          status: entry.status,
          confidence: entry.confidence ?? null,
          summary: entry.summary ?? null,
          lastUpdatedTurn: entry.turnNumbers.length > 0
            ? entry.turnNumbers[entry.turnNumbers.length - 1]
            : null,
        }));

        const activeThreads = session.activeThreads.map((thread, idx) => ({
          id: `thread-${idx}`,
          topic: thread.topic,
          status: 'open',
          relatedQuestionIds: thread.questionIds,
          openedAtTurn: thread.openedAtTurn,
        }));

        return {
          interviewId: args.interviewId,
          sessionVersion: session.sessionVersion,
          entries,
          activeThreads,
          parseFailureCount: session.consecutiveParseFailures,
        };
      } catch {
        return null;
      }
    },
  },

  // =========================================================================
  // Mutations
  // =========================================================================
  Mutation: {
    // --- Tag management (admin only) ---

    async createTag(
      _parent: unknown,
      args: { label: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const existing = await ctx.prisma.tag.findUnique({ where: { label: args.label } });
      if (existing) {
        throw duplicateEntry('Tag with this label already exists', { label: args.label });
      }
      return ctx.prisma.tag.create({ data: { label: args.label } });
    },

    async updateTag(
      _parent: unknown,
      args: {
        id: string;
        label?: string | null;
        isActive?: boolean | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const tag = await ctx.prisma.tag.findUnique({ where: { id: args.id } });
      if (!tag) throw notFound('Tag not found', { tagId: args.id });

      if (args.label && args.label !== tag.label) {
        const dup = await ctx.prisma.tag.findUnique({ where: { label: args.label } });
        if (dup) throw duplicateEntry('Tag with this label already exists', { label: args.label });
      }

      const data: Record<string, unknown> = {};
      if (args.label != null) data.label = args.label;
      if (args.isActive != null) data.isActive = args.isActive;

      return ctx.prisma.tag.update({ where: { id: args.id }, data });
    },

    // --- Question management (admin only) ---

    async createQuestion(
      _parent: unknown,
      args: { text: string; tagIds?: string[] | null },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      return ctx.prisma.question.create({
        data: {
          text: args.text,
          questionTags:
            args.tagIds && args.tagIds.length > 0
              ? { create: args.tagIds.map((tagId) => ({ tagId })) }
              : undefined,
        },
      });
    },

    async updateQuestion(
      _parent: unknown,
      args: {
        id: string;
        text?: string | null;
        tagIds?: string[] | null;
        isActive?: boolean | null;
        intent?: string | null;
        sensitivityLevel?: string | null;
      },
      ctx: ArenaContext,
    ) {
      const admin = requireAdmin(ctx);
      const question = await ctx.prisma.question.findUnique({ where: { id: args.id } });
      if (!question) throw notFound('Question not found', { questionId: args.id });

      const data: Record<string, unknown> = {};
      if (args.text != null) data.text = args.text;
      if (args.isActive != null) data.isActive = args.isActive;
      if (args.intent !== undefined) data.intent = args.intent;
      if (args.sensitivityLevel != null) data.sensitivityLevel = args.sensitivityLevel;

      // Build changes for audit log
      const changes: Record<string, unknown> = {};
      if (args.text != null) changes.text = args.text;
      if (args.isActive != null) changes.isActive = args.isActive;
      if (args.intent !== undefined) changes.intent = args.intent;
      if (args.sensitivityLevel != null) changes.sensitivityLevel = args.sensitivityLevel;

      if (args.tagIds !== undefined && args.tagIds !== null) {
        changes.tagIds = args.tagIds;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ctx.prisma.$transaction(async (tx: any) => {
          await tx.questionTag.deleteMany({ where: { questionId: args.id } });
          if (args.tagIds!.length > 0) {
            await tx.questionTag.createMany({
              data: args.tagIds!.map((tagId: string) => ({ questionId: args.id, tagId })),
            });
          }
          await tx.adminAuditLog.create({
            data: {
              actorId: admin.userId,
              action: 'updateQuestion',
              entityType: 'Question',
              entityId: args.id,
              changes,
            },
          });
          return tx.question.update({ where: { id: args.id }, data });
        });
      }

      return ctx.prisma.$transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await tx.adminAuditLog.create({
          data: {
            actorId: admin.userId,
            action: 'updateQuestion',
            entityType: 'Question',
            entityId: args.id,
            changes,
          },
        });
        return tx.question.update({ where: { id: args.id }, data });
      });
    },

    // --- Template management (admin only) ---

    async createTemplate(
      _parent: unknown,
      args: { name: string; description?: string | null; systemPrompt?: string | null },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      return ctx.prisma.interviewTemplate.create({
        data: { name: args.name, description: args.description ?? null, systemPrompt: args.systemPrompt ?? null, status: 'draft' },
      });
    },

    async updateTemplate(
      _parent: unknown,
      args: {
        id: string;
        name?: string | null;
        description?: string | null;
        systemPrompt?: string | null;
        status?: string | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const template = await ctx.prisma.interviewTemplate.findUnique({ where: { id: args.id } });
      if (!template) throw notFound('Template not found', { templateId: args.id });

      if (args.status === 'published') {
        const questionCount = await ctx.prisma.templateQuestion.count({
          where: { templateId: args.id },
        });
        if (questionCount === 0) {
          throw invalidState('Cannot publish template with zero questions', {
            templateId: args.id,
          });
        }
      }

      const data: Record<string, unknown> = {};
      if (args.name != null) data.name = args.name;
      if (args.description !== undefined) data.description = args.description;
      if (args.systemPrompt !== undefined) data.systemPrompt = args.systemPrompt;
      if (args.status != null) data.status = args.status;

      return ctx.prisma.interviewTemplate.update({ where: { id: args.id }, data });
    },

    async addQuestionToTemplate(
      _parent: unknown,
      args: {
        templateId: string;
        questionId: string;
        sequenceOrder: number;
        categoryBucket: string;
        isRequired?: boolean | null;
        followupTriggers?: unknown;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);

      // Find the current max sequence_order to avoid unique constraint conflicts
      const maxResult = await ctx.prisma.templateQuestion.aggregate({
        where: { templateId: args.templateId },
        _max: { sequenceOrder: true },
      });
      const nextOrder = (maxResult._max.sequenceOrder ?? 0) + 1;

      return ctx.prisma.templateQuestion.create({
        data: {
          templateId: args.templateId,
          questionId: args.questionId,
          sequenceOrder: nextOrder,
          categoryBucket: args.categoryBucket,
          isRequired: args.isRequired ?? true,
          followupTriggers: (args.followupTriggers ?? []) as string,
        },
      });
    },

    async updateTemplateQuestion(
      _parent: unknown,
      args: {
        id: string;
        sequenceOrder?: number | null;
        categoryBucket?: string | null;
        isRequired?: boolean | null;
        followupTriggers?: unknown;
        adminNotes?: string | null;
      },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const tq = await ctx.prisma.templateQuestion.findUnique({ where: { id: args.id } });
      if (!tq) throw notFound('Template question not found', { templateQuestionId: args.id });

      const data: Record<string, unknown> = {};
      if (args.sequenceOrder != null) data.sequenceOrder = args.sequenceOrder;
      if (args.categoryBucket != null) data.categoryBucket = args.categoryBucket;
      if (args.isRequired != null) data.isRequired = args.isRequired;
      if (args.followupTriggers !== undefined) data.followupTriggers = args.followupTriggers as string;
      if (args.adminNotes !== undefined) data.adminNotes = args.adminNotes;

      return ctx.prisma.templateQuestion.update({ where: { id: args.id }, data });
    },

    async reorderTemplateQuestions(
      _parent: unknown,
      args: { templateId: string; orderedIds: string[] },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);

      // Verify all IDs belong to this template
      const existing = await ctx.prisma.templateQuestion.findMany({
        where: { templateId: args.templateId },
      });
      const existingIds = new Set(existing.map((tq) => tq.id));
      for (const id of args.orderedIds) {
        if (!existingIds.has(id)) {
          throw notFound('Template question not found in this template', { templateQuestionId: id });
        }
      }

      // Use a transaction: first set all to negative temps to avoid unique constraint
      // collisions, then set the final values.
      return ctx.prisma.$transaction(async (tx) => {
        // Phase 1: clear to negative temporary values
        await Promise.all(
          args.orderedIds.map((id, i) =>
            tx.templateQuestion.update({
              where: { id },
              data: { sequenceOrder: -(i + 1) },
            })
          )
        );
        // Phase 2: set final positive values
        await Promise.all(
          args.orderedIds.map((id, i) =>
            tx.templateQuestion.update({
              where: { id },
              data: { sequenceOrder: i + 1 },
            })
          )
        );
        return tx.templateQuestion.findMany({
          where: { templateId: args.templateId },
          orderBy: { sequenceOrder: 'asc' },
        });
      });
    },

    async removeQuestionFromTemplate(
      _parent: unknown,
      args: { id: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);
      const tq = await ctx.prisma.templateQuestion.findUnique({ where: { id: args.id } });
      if (!tq) throw notFound('Template question not found', { templateQuestionId: args.id });

      const otherTqs = await ctx.prisma.templateQuestion.findMany({
        where: { templateId: tq.templateId, id: { not: tq.id } },
      });
      for (const otherTq of otherTqs) {
        if (isQuestionReferencedInTriggers(tq.questionId, otherTq.followupTriggers)) {
          throw invalidState(
            'Cannot remove question that is referenced in follow-up triggers',
            { templateQuestionId: args.id, referencedByTemplateQuestionId: otherTq.id },
          );
        }
      }

      await ctx.prisma.templateQuestion.delete({ where: { id: args.id } });
      return true;
    },

    // --- User management (admin only) ---

    async assignTemplateToUser(
      _parent: unknown,
      args: { userId: string; templateId: string },
      ctx: ArenaContext,
    ) {
      const admin = requireAdmin(ctx);

      const template = await ctx.prisma.interviewTemplate.findUnique({
        where: { id: args.templateId },
      });
      if (!template) throw notFound('Template not found', { templateId: args.templateId });
      if (template.status !== 'published') {
        throw invalidState('Cannot assign unpublished template to user', {
          templateId: args.templateId,
          templateStatus: template.status,
        });
      }

      const existing = await ctx.prisma.userTemplate.findFirst({
        where: { userId: args.userId, templateId: args.templateId },
      });

      if (existing && existing.status === 'active') {
        throw duplicateEntry('User already has an active assignment for this template', {
          userId: args.userId,
          templateId: args.templateId,
        });
      }

      if (existing) {
        const [assignment] = await ctx.prisma.$transaction([
          ctx.prisma.userTemplate.update({
            where: { id: existing.id },
            data: {
              status: 'active',
              assignedBy: admin.userId,
              assignedAt: new Date(),
              completedAt: null,
              removedAt: null,
            },
          }),
          ctx.prisma.templateAssignmentHistory.create({
            data: {
              userId: args.userId,
              templateId: args.templateId,
              assignedBy: admin.userId,
            },
          }),
        ]);
        return assignment;
      }

      const [assignment] = await ctx.prisma.$transaction([
        ctx.prisma.userTemplate.create({
          data: {
            userId: args.userId,
            templateId: args.templateId,
            assignedBy: admin.userId,
            status: 'active',
          },
        }),
        ctx.prisma.templateAssignmentHistory.create({
          data: {
            userId: args.userId,
            templateId: args.templateId,
            assignedBy: admin.userId,
          },
        }),
      ]);
      return assignment;
    },

    async removeTemplateFromUser(
      _parent: unknown,
      args: { userId: string; templateId: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);

      const assignment = await ctx.prisma.userTemplate.findFirst({
        where: { userId: args.userId, templateId: args.templateId, status: 'active' },
      });
      if (!assignment) {
        throw notFound('Active assignment not found', {
          userId: args.userId,
          templateId: args.templateId,
        });
      }

      const interview = await ctx.prisma.interview.findFirst({
        where: {
          userId: args.userId,
          templateId: args.templateId,
          status: { in: ['in_progress', 'paused'] },
        },
        include: {
          responses: { select: { id: true } },
          template: { include: { templateQuestions: { select: { id: true } } } },
        },
      });

      if (interview) {
        const totalQuestions = interview.template.templateQuestions.length;
        const answeredQuestions = interview.responses.length;
        const percentage =
          totalQuestions > 0
            ? Math.round((answeredQuestions / totalQuestions) * 100)
            : 0;
        const elapsedMs = interview.startedAt
          ? Date.now() - new Date(interview.startedAt).getTime()
          : 0;

        throw invalidState(
          'Cannot remove template assignment while user has an active interview',
          {
            interviewId: interview.id,
            status: interview.status,
            startedAt: interview.startedAt
              ? new Date(interview.startedAt).toISOString()
              : '',
            elapsedDuration: `${Math.floor(elapsedMs / 1000)}s`,
            percentageAnswered: percentage,
          },
        );
      }

      const now = new Date();
      await ctx.prisma.$transaction([
        ctx.prisma.userTemplate.update({
          where: { id: assignment.id },
          data: { status: 'removed', removedAt: now },
        }),
        ctx.prisma.templateAssignmentHistory.updateMany({
          where: {
            userId: args.userId,
            templateId: args.templateId,
            unassignedAt: null,
          },
          data: { unassignedAt: now, unassignedReason: 'admin_removed' },
        }),
      ]);

      return true;
    },

    async syncUserRole(
      _parent: unknown,
      args: { userId: string },
      ctx: ArenaContext,
    ) {
      requireAdmin(ctx);

      const user = await ctx.prisma.user.findUnique({ where: { id: args.userId } });
      if (!user) throw notFound('User not found', { userId: args.userId });

      try {
        const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } =
          await import('@aws-sdk/client-cognito-identity-provider');

        const client = new CognitoIdentityProviderClient({
          region: process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-2',
        });

        const response = await client.send(
          new AdminListGroupsForUserCommand({
            Username: user.id,
            UserPoolId: process.env.COGNITO_USER_POOL_ID!,
          }),
        );

        const groups = (response.Groups ?? [])
          .map((g: { GroupName?: string }) => g.GroupName)
          .filter((name: string | undefined): name is string => !!name);
        const newRole = groups.includes('admin') ? 'admin' : 'user';

        return ctx.prisma.user.update({
          where: { id: args.userId },
          data: { role: newRole },
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('Cannot find module') ||
            err.message.includes('MODULE_NOT_FOUND'))
        ) {
          throw externalServiceError('Cognito SDK not available');
        }
        throw externalServiceError('Failed to sync user role from Cognito');
      }
    },

    // --- Consent operations ---

    async grantConsent(
      _parent: unknown,
      args: { consentType: string; consentVersion: string },
      ctx: ArenaContext,
    ) {
      const user = requireAuth(ctx);

      const existing = await ctx.prisma.userConsentRecord.findFirst({
        where: { userId: user.userId, consentType: args.consentType, revokedAt: null },
      });

      if (existing) {
        if (existing.consentVersion === args.consentVersion) {
          return { success: true };
        }
        await ctx.prisma.userConsentRecord.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });
      }

      await ctx.prisma.userConsentRecord.create({
        data: {
          userId: user.userId,
          consentType: args.consentType,
          consentVersion: args.consentVersion,
        },
      });

      return { success: true };
    },

    async revokeConsent(
      _parent: unknown,
      args: { consentType: string },
      ctx: ArenaContext,
    ) {
      const user = requireAuth(ctx);

      const existing = await ctx.prisma.userConsentRecord.findFirst({
        where: { userId: user.userId, consentType: args.consentType, revokedAt: null },
      });

      if (existing) {
        await ctx.prisma.userConsentRecord.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });
      }

      return { success: true };
    },

    // --- Data subject operations ---

    async requestDataDeletion(_parent: unknown, _args: unknown, ctx: ArenaContext) {
      requireAuth(ctx);
      return { success: true };
    },

    // --- Interview engine ---

    async startInterview(
      _parent: unknown,
      args: { templateId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await startInterviewService(ctx.prisma, ctx.user!.userId, args.templateId);
      return { interviewId: result.id, totalQuestions: result.totalQuestions };
    },

    async abandonInterview(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await abandonInterviewService(ctx.prisma, ctx.user!.userId, args.interviewId);
      return result;
    },

    async submitResponse(
      _parent: unknown,
      args: { interviewId: string; rawTranscription: string; inputMode: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await submitResponseService(ctx.prisma, ctx.user!.userId, args, {
        claude: getClaudeClient(),
        streamingClaude: getStreamingClaudeClient(),
      });
      void pushTurnToSSE(args.interviewId);
      return result;
    },

    async completeInterview(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      return completeInterviewService(ctx.prisma, ctx.user!.userId, args.interviewId, { events: createEventPublisher() });
    },

    async skipQuestion(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await skipQuestionService(ctx.prisma, ctx.user!.userId, args.interviewId, { claude: getClaudeClient() });
      void pushTurnToSSE(args.interviewId);
      return result;
    },

    async pauseInterview(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await pauseInterviewService(ctx.prisma, ctx.user!.userId, args.interviewId);
      return ctx.prisma.interview.findUnique({ where: { id: result.id } });
    },

    async resumeInterview(
      _parent: unknown,
      args: { interviewId: string },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await resumeInterviewService(ctx.prisma, ctx.user!.userId, args.interviewId);
      return ctx.prisma.interview.findUnique({ where: { id: result.id } });
    },

    async confirmAudioUpload(
      _parent: unknown,
      args: {
        responseId: string;
        s3Key: string;
        mimeType: string;
        durationSeconds: number;
      },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      await ctx.prisma.interviewResponse.update({
        where: { id: args.responseId },
        data: {
          s3AudioKey: args.s3Key,
          audioMimeType: args.mimeType,
          audioDurationSeconds: args.durationSeconds,
          audioUploadStatus: 'completed',
        },
      });
      return { success: true };
    },

    async confirmDraftAudioUpload(
      _parent: unknown,
      args: {
        draftId: string;
        s3Key: string;
        mimeType: string;
        durationSeconds: number;
      },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      await ctx.prisma.responseDraft.update({
        where: { id: args.draftId },
        data: {
          s3AudioKey: args.s3Key,
          audioMimeType: args.mimeType,
          audioDurationSeconds: args.durationSeconds,
          audioUploadStatus: 'completed',
        },
      });
      return { success: true };
    },

    // --- Draft operations ---

    async saveDraft(
      _parent: unknown,
      args: {
        interviewId: string;
        content: string;
        inputMode: string;
        sttConfidenceScore?: number | null;
      },
      ctx: ArenaContext,
    ) {
      requireAuth(ctx);
      const result = await saveDraftService(ctx.prisma, ctx.user!.userId, args);
      return { draftId: result.id };
    },

    // --- Pipeline operations ---

    async updateCleanedContent(
      _parent: unknown,
      args: {
        interviewResponseId: string;
        cleanedMarkdown: string;
        cleaningModel: string;
      },
      ctx: ArenaContext,
    ) {
      await ctx.prisma.interviewResponse.update({
        where: { id: args.interviewResponseId },
        data: {
          cleanedMarkdown: args.cleanedMarkdown,
          cleaningModel: args.cleaningModel,
          cleanedAt: new Date(),
          processingStatus: 'completed',
        },
      });
      return { success: true };
    },

    // --- Flagged item review (admin only) ---

    async resolveFlaggedItem(
      _parent: unknown,
      args: { id: string; status: string; notes?: string | null },
      ctx: ArenaContext,
    ) {
      const admin = requireAdmin(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = await (ctx.prisma as any).flaggedItem.findUnique({ where: { id: args.id } });
      if (!item) throw notFound('Flagged item not found', { flaggedItemId: args.id });

      const validStatuses = ['pending', 'reviewed', 'resolved', 'dismissed'];
      if (!validStatuses.includes(args.status)) {
        throw validationError('Invalid status value', { status: args.status });
      }

      // Map GQL status to Prisma fields
      const updateData: Record<string, unknown> = {};
      switch (args.status) {
        case 'dismissed':
          updateData.dismissedAt = new Date();
          updateData.needsAdminReview = false;
          break;
        case 'resolved':
          updateData.needsAdminReview = false;
          break;
        case 'reviewed':
          updateData.needsAdminReview = false;
          break;
        case 'pending':
          updateData.needsAdminReview = true;
          updateData.dismissedAt = null;
          break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (ctx.prisma as any).$transaction(async (tx: any) => {
        await tx.adminAuditLog.create({
          data: {
            actorId: admin.userId,
            action: 'resolveFlaggedItem',
            entityType: 'FlaggedItem',
            entityId: args.id,
            changes: { status: args.status, ...(args.notes ? { notes: args.notes } : {}) },
          },
        });
        return tx.flaggedItem.update({ where: { id: args.id }, data: updateData });
      });

      return mapFlaggedItem(updated as FlaggedItemRow);
    },

    // --- Tag merge proposal review (admin only) ---

    async approveTagMergeProposal(
      _parent: unknown,
      args: { id: string; canonicalTagId?: string | null },
      ctx: ArenaContext,
    ) {
      const admin = requireAdmin(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proposal = await (ctx.prisma as any).tagMergeProposal.findUnique({ where: { id: args.id } });
      if (!proposal) throw notFound('Tag merge proposal not found', { proposalId: args.id });
      if (proposal.status !== 'PENDING') {
        throw invalidState('Tag merge proposal is not in pending status', { proposalId: args.id, status: proposal.status });
      }

      const targetTagId = args.canonicalTagId ?? proposal.canonicalTagId;

      // Verify target tag exists
      const targetTag = await ctx.prisma.tag.findUnique({ where: { id: targetTagId } });
      if (!targetTag) throw notFound('Target tag not found', { tagId: targetTagId });

      const now = new Date();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (ctx.prisma as any).$transaction(async (tx: any) => {
        // Remap questionTags from candidate tags to canonical tag (deduplicate)
        if (proposal.candidateTagIds && proposal.candidateTagIds.length > 0) {
          for (const candidateTagId of proposal.candidateTagIds as string[]) {
            // Find all question associations for this candidate tag
            const qtRows = await tx.questionTag.findMany({
              where: { tagId: candidateTagId },
            });
            for (const qt of qtRows) {
              // Check if target mapping already exists
              const exists = await tx.questionTag.findFirst({
                where: { questionId: qt.questionId, tagId: targetTagId },
              });
              if (!exists) {
                await tx.questionTag.create({
                  data: { questionId: qt.questionId, tagId: targetTagId },
                });
              }
            }
            // Remove old question-tag associations
            await tx.questionTag.deleteMany({ where: { tagId: candidateTagId } });
            // Soft-delete candidate tag
            await tx.tag.update({ where: { id: candidateTagId }, data: { isActive: false } });
          }
        }

        await tx.adminAuditLog.create({
          data: {
            actorId: admin.userId,
            action: 'approveTagMergeProposal',
            entityType: 'TagMergeProposal',
            entityId: args.id,
            changes: {
              targetTagId,
              candidateTagIds: proposal.candidateTagIds,
            },
          },
        });

        return tx.tagMergeProposal.update({
          where: { id: args.id },
          data: { status: 'APPROVED', reviewedBy: admin.userId, reviewedAt: now },
        });
      });
    },

    async rejectTagMergeProposal(
      _parent: unknown,
      args: { id: string; reason: string },
      ctx: ArenaContext,
    ) {
      const admin = requireAdmin(ctx);

      if (!args.reason || args.reason.trim().length === 0) {
        throw validationError('Rejection reason must not be empty', { proposalId: args.id });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proposal = await (ctx.prisma as any).tagMergeProposal.findUnique({ where: { id: args.id } });
      if (!proposal) throw notFound('Tag merge proposal not found', { proposalId: args.id });
      if (proposal.status !== 'PENDING') {
        throw invalidState('Tag merge proposal is not in pending status', { proposalId: args.id, status: proposal.status });
      }

      const now = new Date();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (ctx.prisma as any).$transaction(async (tx: any) => {
        await tx.adminAuditLog.create({
          data: {
            actorId: admin.userId,
            action: 'rejectTagMergeProposal',
            entityType: 'TagMergeProposal',
            entityId: args.id,
            changes: { reason: args.reason },
          },
        });
        return tx.tagMergeProposal.update({
          where: { id: args.id },
          data: { status: 'REJECTED', reviewedBy: admin.userId, reviewedAt: now },
        });
      });
    },
  },

  // =========================================================================
  // Field Resolvers
  // =========================================================================

  Question: {
    tags: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.tagsByQuestionId.load(parent.id),
  },

  InterviewTemplate: {
    questions: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.templateQuestionsByTemplateId.load(parent.id),
  },

  TemplateQuestion: {
    question: (parent: { questionId: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.questionById.load(parent.questionId),
    followupTriggers: (parent: { followupTriggers: unknown }) =>
      parent.followupTriggers ?? [],
  },

  User: {
    assignedTemplates: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.assignmentsByUserId.load(parent.id),
    tags: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.tagsByUserId.load(parent.id),
    consentStatus: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.consentStatusByUserId.load(parent.id),
  },

  UserTemplateAssignment: {
    template: (parent: { templateId: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.templateById.load(parent.templateId),
    assignedAt: (parent: { assignedAt: Date | string }) =>
      parent.assignedAt instanceof Date
        ? parent.assignedAt.toISOString()
        : parent.assignedAt,
    completedAt: (parent: { completedAt: Date | string | null }) =>
      parent.completedAt instanceof Date
        ? parent.completedAt.toISOString()
        : parent.completedAt,
  },

  Interview: {
    user: (parent: { userId: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.userById.load(parent.userId),
    template: (parent: { templateId: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.templateById.load(parent.templateId),
    responses: (parent: { id: string }, _args: unknown, ctx: ArenaContext) =>
      ctx.loaders.responsesByInterviewId.load(parent.id),
    costSummary: (parent: {
      totalLlmPromptTokens: number;
      totalLlmCompletionTokens: number;
      totalSttDurationSeconds: unknown;
      totalTtsCharacters: number;
    }) => ({
      totalLlmPromptTokens: parent.totalLlmPromptTokens,
      totalLlmCompletionTokens: parent.totalLlmCompletionTokens,
      totalSttDurationSeconds: Number(parent.totalSttDurationSeconds),
      totalTtsCharacters: parent.totalTtsCharacters,
    }),
    startedAt: (parent: { startedAt: Date | string | null }) =>
      parent.startedAt instanceof Date
        ? parent.startedAt.toISOString()
        : parent.startedAt,
    completedAt: (parent: { completedAt: Date | string | null }) =>
      parent.completedAt instanceof Date
        ? parent.completedAt.toISOString()
        : parent.completedAt,
    pausedAt: (parent: { pausedAt: Date | string | null }) =>
      parent.pausedAt instanceof Date
        ? parent.pausedAt.toISOString()
        : parent.pausedAt,
  },

  InterviewResponse: {
    audioMetadata: (parent: {
      s3AudioKey: string | null;
      audioMimeType: string | null;
      audioDurationSeconds: unknown;
    }) => {
      if (!parent.s3AudioKey) return null;
      return {
        s3Key: parent.s3AudioKey,
        mimeType: parent.audioMimeType ?? '',
        durationSeconds: Number(parent.audioDurationSeconds ?? 0),
      };
    },
    respondedAt: (parent: { respondedAt: Date | string }) =>
      parent.respondedAt instanceof Date
        ? parent.respondedAt.toISOString()
        : parent.respondedAt,
  },

  ResponseDraft: {
    createdAt: (parent: { createdAt: Date | string }) =>
      parent.createdAt instanceof Date
        ? parent.createdAt.toISOString()
        : parent.createdAt,
    sttConfidenceScore: (parent: { sttConfidenceScore: unknown }) =>
      parent.sttConfidenceScore != null ? Number(parent.sttConfidenceScore) : null,
  },

  TemplateAssignmentRecord: {
    assignedAt: (parent: { assignedAt: Date | string }) =>
      parent.assignedAt instanceof Date
        ? parent.assignedAt.toISOString()
        : parent.assignedAt,
    unassignedAt: (parent: { unassignedAt: Date | string | null }) =>
      parent.unassignedAt instanceof Date
        ? parent.unassignedAt.toISOString()
        : parent.unassignedAt,
  },

  AuditLogEntry: {
    actorName: async (
      parent: { actorId: string },
      _args: unknown,
      ctx: ArenaContext,
    ) => {
      const user = await ctx.loaders.userById.load(parent.actorId);
      return user?.name ?? null;
    },
    createdAt: (parent: { createdAt: Date | string }) =>
      parent.createdAt instanceof Date
        ? parent.createdAt.toISOString()
        : parent.createdAt,
  },

  TagMergeProposal: {
    status: (parent: { status: string }) => parent.status.toLowerCase(),
    proposedAt: (parent: { proposedAt: Date | string }) =>
      parent.proposedAt instanceof Date
        ? parent.proposedAt.toISOString()
        : parent.proposedAt,
    createdAt: (parent: { createdAt: Date | string }) =>
      parent.createdAt instanceof Date
        ? parent.createdAt.toISOString()
        : parent.createdAt,
    reviewedAt: (parent: { reviewedAt: Date | string | null }) =>
      parent.reviewedAt instanceof Date
        ? parent.reviewedAt.toISOString()
        : parent.reviewedAt ?? null,
    rejectedReason: (_parent: unknown) => null, // not stored in Prisma model — reserved for future
  },
};
