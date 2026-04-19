// ---------------------------------------------------------------------------
// Arena — New Admin Surfaces Tests (Phase 3)
// Covers: flaggedItems, coverageMap, resolveFlaggedItem,
//         approveTagMergeProposal, rejectTagMergeProposal, updateQuestion
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers } from '../schema/resolvers';

// ---------------------------------------------------------------------------
// Mock Redis (used by coverageMap)
// ---------------------------------------------------------------------------

const mockRedisGet = vi.fn();
vi.mock('../services/redis', () => ({
  getRedisClient: () => ({ get: mockRedisGet }),
}));

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    tag: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    question: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    questionTag: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    interviewTemplate: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    templateQuestion: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { sequenceOrder: 0 } }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    userTemplate: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    templateAssignmentHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    interview: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    interviewResponse: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    responseDraft: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    userConsentRecord: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    adminAuditLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
    flaggedItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    tagMergeProposal: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

// Shared mutable reference — reassigned per context factory call
let mockPrisma: ReturnType<typeof createMockPrisma>;

function createMockLoaders() {
  return {
    tagById: { load: vi.fn(), loadMany: vi.fn() },
    tagsByQuestionId: { load: vi.fn().mockResolvedValue([]) },
    tagsByUserId: { load: vi.fn().mockResolvedValue([]) },
    questionById: { load: vi.fn().mockResolvedValue(null) },
    responsesByInterviewId: { load: vi.fn().mockResolvedValue([]) },
    responseById: { load: vi.fn().mockResolvedValue(null) },
    userById: { load: vi.fn().mockResolvedValue(null) },
    templateById: { load: vi.fn().mockResolvedValue(null) },
    templateQuestionsByTemplateId: { load: vi.fn().mockResolvedValue([]) },
    consentStatusByUserId: {
      load: vi.fn().mockResolvedValue({
        dataProcessing: false,
        audioRecording: false,
        aiInteraction: false,
        allGranted: false,
      }),
    },
    assignmentsByUserId: { load: vi.fn().mockResolvedValue([]) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

function adminCtx(): Ctx {
  const prisma = createMockPrisma();
  mockPrisma = prisma;
  prisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === 'function') return (arg as CallableFunction)(prisma);
    return arg;
  });
  return {
    user: { userId: 'admin-001', groups: ['admin'], email: 'admin@test.com' },
    prisma,
    loaders: createMockLoaders(),
  };
}

function userCtx(): Ctx {
  const prisma = createMockPrisma();
  mockPrisma = prisma;
  prisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === 'function') return (arg as CallableFunction)(prisma);
    return arg;
  });
  return {
    user: { userId: 'user-001', groups: ['user'], email: 'user@test.com' },
    prisma,
    loaders: createMockLoaders(),
  };
}

const Q = resolvers.Query;
const M = resolvers.Mutation;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Sample Prisma FlaggedItem row
// ---------------------------------------------------------------------------

function makeFlaggedItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fi-001',
    interviewId: 'int-001',
    sourceTurn: 3,
    priority: 'HIGH',
    description: 'Candidate mentioned something worth flagging',
    suggestedTags: ['ethics', 'sensitive'],
    needsAdminReview: true,
    dismissedAt: null,
    convertedToQuestionId: null,
    createdAt: new Date('2026-04-01T10:00:00Z'),
    updatedAt: new Date('2026-04-01T10:00:00Z'),
    ...overrides,
  };
}

// ===========================================================================
// Query: flaggedItems
// ===========================================================================

describe('Query.flaggedItems', () => {
  it('admin can query flaggedItems', async () => {
    const ctx = adminCtx();
    const row = makeFlaggedItemRow();
    ctx.prisma.flaggedItem.findMany.mockResolvedValue([row]);

    const result = await Q.flaggedItems({}, {}, ctx);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fi-001');
    expect(result[0].status).toBe('pending');
    expect(result[0].priority).toBe('high');
    expect(result[0].suggestedTags).toEqual(['ethics', 'sensitive']);
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(Q.flaggedItems({}, {}, userCtx())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('filters by status=pending', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findMany.mockResolvedValue([]);

    await Q.flaggedItems({}, { status: 'pending' }, ctx);
    const callArgs = ctx.prisma.flaggedItem.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      needsAdminReview: true,
      dismissedAt: null,
      convertedToQuestionId: null,
    });
  });

  it('filters by status=dismissed', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findMany.mockResolvedValue([]);

    await Q.flaggedItems({}, { status: 'dismissed' }, ctx);
    const callArgs = ctx.prisma.flaggedItem.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({ dismissedAt: { not: null } });
  });

  it('filters by priority=critical', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findMany.mockResolvedValue([]);

    await Q.flaggedItems({}, { priority: 'critical' }, ctx);
    const callArgs = ctx.prisma.flaggedItem.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({ priority: 'CRITICAL' });
  });

  it('filters by both status and priority', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findMany.mockResolvedValue([]);

    await Q.flaggedItems({}, { status: 'pending', priority: 'high' }, ctx);
    const callArgs = ctx.prisma.flaggedItem.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      needsAdminReview: true,
      priority: 'HIGH',
    });
  });
});

// ===========================================================================
// Query: flaggedItem (single)
// ===========================================================================

describe('Query.flaggedItem', () => {
  it('returns a flagged item by id', async () => {
    const ctx = adminCtx();
    const row = makeFlaggedItemRow();
    ctx.prisma.flaggedItem.findUnique.mockResolvedValue(row);

    const result = await Q.flaggedItem({}, { id: 'fi-001' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('fi-001');
  });

  it('returns null for missing item', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findUnique.mockResolvedValue(null);

    const result = await Q.flaggedItem({}, { id: 'nope' }, ctx);
    expect(result).toBeNull();
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(Q.flaggedItem({}, { id: 'fi-001' }, userCtx())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });
});

// ===========================================================================
// Query: coverageMap
// ===========================================================================

describe('Query.coverageMap', () => {
  it('returns null for missing interview', async () => {
    const ctx = adminCtx();
    ctx.prisma.interview.findUnique.mockResolvedValue(null);

    const result = await Q.coverageMap({}, { interviewId: 'nope' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null when no Redis session exists', async () => {
    const ctx = adminCtx();
    ctx.prisma.interview.findUnique.mockResolvedValue({ id: 'int-001', status: 'in_progress' });
    mockRedisGet.mockResolvedValue(null);

    const result = await Q.coverageMap({}, { interviewId: 'int-001' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null for v1-pool session', async () => {
    const ctx = adminCtx();
    ctx.prisma.interview.findUnique.mockResolvedValue({ id: 'int-001', status: 'in_progress' });
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ sessionVersion: 'v1-pool', coverage: {}, activeThreads: [], consecutiveParseFailures: 0 }),
    );

    const result = await Q.coverageMap({}, { interviewId: 'int-001' }, ctx);
    expect(result).toBeNull();
  });

  it('returns populated map for v2-coverage session', async () => {
    const ctx = adminCtx();
    ctx.prisma.interview.findUnique.mockResolvedValue({ id: 'int-001', status: 'in_progress' });

    const sessionState = {
      interviewId: 'int-001',
      sessionVersion: 'v2-coverage',
      consecutiveParseFailures: 1,
      coverage: {
        'q-001': {
          status: 'fully_covered',
          confidence: 'high',
          summary: 'Great response',
          turnNumbers: [2, 4],
        },
        'q-002': {
          status: 'not_started',
          confidence: null,
          summary: null,
          turnNumbers: [],
        },
      },
      activeThreads: [
        { topic: 'leadership', openedAtTurn: 3, questionIds: ['q-001'] },
      ],
    };
    mockRedisGet.mockResolvedValue(JSON.stringify(sessionState));

    const result = await Q.coverageMap({}, { interviewId: 'int-001' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.interviewId).toBe('int-001');
    expect(result!.sessionVersion).toBe('v2-coverage');
    expect(result!.parseFailureCount).toBe(1);
    expect(result!.entries).toHaveLength(2);

    const q1 = result!.entries.find((e: { questionId: string }) => e.questionId === 'q-001');
    expect(q1).toBeDefined();
    expect(q1!.status).toBe('fully_covered');
    expect(q1!.confidence).toBe('high');
    expect(q1!.lastUpdatedTurn).toBe(4);

    const q2 = result!.entries.find((e: { questionId: string }) => e.questionId === 'q-002');
    expect(q2!.lastUpdatedTurn).toBeNull();

    expect(result!.activeThreads).toHaveLength(1);
    expect(result!.activeThreads[0].topic).toBe('leadership');
    expect(result!.activeThreads[0].openedAtTurn).toBe(3);
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(Q.coverageMap({}, { interviewId: 'i1' }, userCtx())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });
});

// ===========================================================================
// Mutation: resolveFlaggedItem
// ===========================================================================

describe('Mutation.resolveFlaggedItem', () => {
  it('dismisses a flagged item and writes audit log', async () => {
    const ctx = adminCtx();
    const row = makeFlaggedItemRow();
    const updatedRow = { ...row, dismissedAt: new Date(), needsAdminReview: false };

    ctx.prisma.flaggedItem.findUnique.mockResolvedValue(row);
    ctx.prisma.flaggedItem.update.mockResolvedValue(updatedRow);
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-001' });

    const result = await M.resolveFlaggedItem(
      {},
      { id: 'fi-001', status: 'dismissed', notes: 'Not relevant' },
      ctx,
    );
    expect(result.status).toBe('dismissed');
    expect(ctx.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-001',
        action: 'resolveFlaggedItem',
        entityType: 'FlaggedItem',
        entityId: 'fi-001',
        changes: { status: 'dismissed', notes: 'Not relevant' },
      }),
    });
  });

  it('resolves a flagged item (sets needsAdminReview=false)', async () => {
    const ctx = adminCtx();
    const row = makeFlaggedItemRow();
    const updatedRow = { ...row, needsAdminReview: false };

    ctx.prisma.flaggedItem.findUnique.mockResolvedValue(row);
    ctx.prisma.flaggedItem.update.mockResolvedValue(updatedRow);
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-002' });

    const result = await M.resolveFlaggedItem({}, { id: 'fi-001', status: 'resolved' }, ctx);
    expect(result.status).toBe('reviewed'); // needsAdminReview=false, no dismissedAt, no convertedToQuestionId
    expect(ctx.prisma.flaggedItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ needsAdminReview: false }),
      }),
    );
  });

  it('fails with NOT_FOUND for missing flagged item', async () => {
    const ctx = adminCtx();
    ctx.prisma.flaggedItem.findUnique.mockResolvedValue(null);

    await expect(
      M.resolveFlaggedItem({}, { id: 'nope', status: 'dismissed' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(
      M.resolveFlaggedItem({}, { id: 'fi-001', status: 'dismissed' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// ===========================================================================
// Mutation: approveTagMergeProposal
// ===========================================================================

describe('Mutation.approveTagMergeProposal', () => {
  function makeProposal(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'tmp-001',
      canonicalTagId: 'tag-canonical',
      candidateTagIds: ['tag-candidate-1'],
      rationale: 'These tags are duplicates',
      status: 'PENDING',
      proposedAt: new Date('2026-04-01T10:00:00Z'),
      createdAt: new Date('2026-04-01T10:00:00Z'),
      updatedAt: new Date('2026-04-01T10:00:00Z'),
      reviewedBy: null,
      reviewedAt: null,
      ...overrides,
    };
  }

  it('approves with canonicalTagId — merges into existing tag', async () => {
    const ctx = adminCtx();
    const proposal = makeProposal();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(proposal);
    ctx.prisma.tag.findUnique.mockResolvedValue({ id: 'tag-canonical', label: 'Canonical', isActive: true });
    ctx.prisma.questionTag.findMany.mockResolvedValue([{ questionId: 'q-001', tagId: 'tag-candidate-1' }]);
    ctx.prisma.questionTag.findFirst.mockResolvedValue(null); // no existing mapping
    ctx.prisma.questionTag.create.mockResolvedValue({});
    ctx.prisma.questionTag.deleteMany.mockResolvedValue({ count: 1 });
    ctx.prisma.tag.update.mockResolvedValue({ id: 'tag-candidate-1', isActive: false });
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-003' });
    const approvedProposal = { ...proposal, status: 'APPROVED', reviewedBy: 'admin-001' };
    ctx.prisma.tagMergeProposal.update.mockResolvedValue(approvedProposal);

    const result = await M.approveTagMergeProposal(
      {},
      { id: 'tmp-001', canonicalTagId: 'tag-canonical' },
      ctx,
    );
    expect(result.status).toBe('APPROVED');
    expect(ctx.prisma.questionTag.create).toHaveBeenCalledWith({
      data: { questionId: 'q-001', tagId: 'tag-canonical' },
    });
    expect(ctx.prisma.tag.update).toHaveBeenCalledWith({
      where: { id: 'tag-candidate-1' },
      data: { isActive: false },
    });
    expect(ctx.prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('approves with canonicalTagId=null — uses proposal canonicalTagId', async () => {
    const ctx = adminCtx();
    const proposal = makeProposal();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(proposal);
    ctx.prisma.tag.findUnique.mockResolvedValue({ id: 'tag-canonical', label: 'Canonical', isActive: true });
    ctx.prisma.questionTag.findMany.mockResolvedValue([]);
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-004' });
    const approvedProposal = { ...proposal, status: 'APPROVED', reviewedBy: 'admin-001' };
    ctx.prisma.tagMergeProposal.update.mockResolvedValue(approvedProposal);

    // canonicalTagId=null → falls back to proposal.canonicalTagId = 'tag-canonical'
    const result = await M.approveTagMergeProposal({}, { id: 'tmp-001', canonicalTagId: null }, ctx);
    expect(result.status).toBe('APPROVED');
    expect(ctx.prisma.tag.findUnique).toHaveBeenCalledWith({ where: { id: 'tag-canonical' } });
  });

  it('fails with NOT_FOUND for missing proposal', async () => {
    const ctx = adminCtx();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(null);

    await expect(
      M.approveTagMergeProposal({}, { id: 'nope' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('fails with INVALID_STATE for non-pending proposal', async () => {
    const ctx = adminCtx();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(makeProposal({ status: 'APPROVED' }));

    await expect(
      M.approveTagMergeProposal({}, { id: 'tmp-001' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_STATE' } });
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(
      M.approveTagMergeProposal({}, { id: 'tmp-001' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// ===========================================================================
// Mutation: rejectTagMergeProposal
// ===========================================================================

describe('Mutation.rejectTagMergeProposal', () => {
  it('rejects a pending proposal with a reason', async () => {
    const ctx = adminCtx();
    const proposal = {
      id: 'tmp-001',
      canonicalTagId: 'tag-canonical',
      candidateTagIds: ['tag-candidate-1'],
      status: 'PENDING',
      proposedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewedBy: null,
      reviewedAt: null,
    };
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(proposal);
    const rejected = { ...proposal, status: 'REJECTED', reviewedBy: 'admin-001' };
    ctx.prisma.tagMergeProposal.update.mockResolvedValue(rejected);
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-005' });

    const result = await M.rejectTagMergeProposal(
      {},
      { id: 'tmp-001', reason: 'These are actually distinct concepts' },
      ctx,
    );
    expect(result.status).toBe('REJECTED');
    expect(ctx.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-001',
        action: 'rejectTagMergeProposal',
        entityType: 'TagMergeProposal',
        changes: { reason: 'These are actually distinct concepts' },
      }),
    });
  });

  it('requires non-empty reason', async () => {
    const ctx = adminCtx();
    await expect(
      M.rejectTagMergeProposal({}, { id: 'tmp-001', reason: '   ' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'VALIDATION_ERROR' } });
  });

  it('fails with NOT_FOUND for missing proposal', async () => {
    const ctx = adminCtx();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue(null);

    await expect(
      M.rejectTagMergeProposal({}, { id: 'nope', reason: 'reason' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('fails with INVALID_STATE for non-pending proposal', async () => {
    const ctx = adminCtx();
    ctx.prisma.tagMergeProposal.findUnique.mockResolvedValue({ id: 'tmp-001', status: 'REJECTED' });

    await expect(
      M.rejectTagMergeProposal({}, { id: 'tmp-001', reason: 'reason' }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_STATE' } });
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(
      M.rejectTagMergeProposal({}, { id: 'tmp-001', reason: 'x' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// ===========================================================================
// Mutation: updateQuestion — intent and sensitivityLevel
// ===========================================================================

describe('Mutation.updateQuestion — intent/sensitivityLevel', () => {
  it('updates intent and sensitivityLevel and writes audit log', async () => {
    const ctx = adminCtx();
    const existing = {
      id: 'q-001',
      text: 'Tell me about yourself',
      isActive: true,
      intent: null,
      sensitivityLevel: 'STANDARD',
    };
    const updated = {
      ...existing,
      intent: 'Assess communication skills',
      sensitivityLevel: 'SENSITIVE',
    };

    ctx.prisma.question.findUnique.mockResolvedValue(existing);
    ctx.prisma.question.update.mockResolvedValue(updated);
    ctx.prisma.adminAuditLog.create.mockResolvedValue({ id: 'al-006' });

    const result = await M.updateQuestion(
      {},
      {
        id: 'q-001',
        intent: 'Assess communication skills',
        sensitivityLevel: 'SENSITIVE',
      },
      ctx,
    );

    expect(result.intent).toBe('Assess communication skills');
    expect(result.sensitivityLevel).toBe('SENSITIVE');
    expect(ctx.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-001',
        action: 'updateQuestion',
        entityType: 'Question',
        entityId: 'q-001',
        changes: expect.objectContaining({
          intent: 'Assess communication skills',
          sensitivityLevel: 'SENSITIVE',
        }),
      }),
    });
  });

  it('sets intent to null (explicit null clears the field)', async () => {
    const ctx = adminCtx();
    const existing = {
      id: 'q-001',
      text: 'Tell me about yourself',
      isActive: true,
      intent: 'Old intent',
      sensitivityLevel: 'STANDARD',
    };
    ctx.prisma.question.findUnique.mockResolvedValue(existing);
    ctx.prisma.question.update.mockResolvedValue({ ...existing, intent: null });
    ctx.prisma.adminAuditLog.create.mockResolvedValue({});

    const result = await M.updateQuestion({}, { id: 'q-001', intent: null }, ctx);
    expect(result.intent).toBeNull();
    const updateCall = ctx.prisma.question.update.mock.calls[0][0];
    expect(updateCall.data.intent).toBeNull();
  });

  it('audit-logs sensitivityLevel changes', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findUnique.mockResolvedValue({
      id: 'q-001', text: 'Q', isActive: true, intent: null, sensitivityLevel: 'STANDARD',
    });
    ctx.prisma.question.update.mockResolvedValue({ id: 'q-001', sensitivityLevel: 'HIGHLY_SENSITIVE' });
    ctx.prisma.adminAuditLog.create.mockResolvedValue({});

    await M.updateQuestion({}, { id: 'q-001', sensitivityLevel: 'HIGHLY_SENSITIVE' }, ctx);

    expect(ctx.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: { sensitivityLevel: 'HIGHLY_SENSITIVE' },
      }),
    });
  });

  it('non-admin gets FORBIDDEN', async () => {
    await expect(
      M.updateQuestion({}, { id: 'q-001', intent: 'x' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// ===========================================================================
// Mutation: updateTemplateQuestion — adminNotes
// ===========================================================================

describe('Mutation.updateTemplateQuestion — adminNotes', () => {
  it('updates adminNotes', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq-001',
      sequenceOrder: 1,
      categoryBucket: 'general',
      adminNotes: null,
    });
    ctx.prisma.templateQuestion.update.mockResolvedValue({
      id: 'tq-001',
      sequenceOrder: 1,
      categoryBucket: 'general',
      adminNotes: 'Probe deeper if answer is vague',
    });

    const result = await M.updateTemplateQuestion(
      {},
      { id: 'tq-001', adminNotes: 'Probe deeper if answer is vague' },
      ctx,
    );
    expect(result.adminNotes).toBe('Probe deeper if answer is vague');
    expect(ctx.prisma.templateQuestion.update).toHaveBeenCalledWith({
      where: { id: 'tq-001' },
      data: { adminNotes: 'Probe deeper if answer is vague' },
    });
  });

  it('clears adminNotes when set to null', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq-001',
      sequenceOrder: 1,
      categoryBucket: 'general',
      adminNotes: 'Old notes',
    });
    ctx.prisma.templateQuestion.update.mockResolvedValue({
      id: 'tq-001',
      adminNotes: null,
    });

    await M.updateTemplateQuestion({}, { id: 'tq-001', adminNotes: null }, ctx);
    const updateCall = ctx.prisma.templateQuestion.update.mock.calls[0][0];
    expect(updateCall.data.adminNotes).toBeNull();
  });
});

// ===========================================================================
// Field Resolvers: TagMergeProposal
// ===========================================================================

describe('Field: TagMergeProposal', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const R = (resolvers as any).TagMergeProposal;

  it('status lowercases from Prisma enum', () => {
    expect(R.status({ status: 'PENDING' })).toBe('pending');
    expect(R.status({ status: 'APPROVED' })).toBe('approved');
    expect(R.status({ status: 'REJECTED' })).toBe('rejected');
  });

  it('proposedAt converts Date to ISO string', () => {
    const d = new Date('2026-04-01T00:00:00Z');
    expect(R.proposedAt({ proposedAt: d })).toBe('2026-04-01T00:00:00.000Z');
  });

  it('reviewedAt returns null when not reviewed', () => {
    expect(R.reviewedAt({ reviewedAt: null })).toBeNull();
  });

  it('rejectedReason returns null (not stored in current schema)', () => {
    expect(R.rejectedReason({})).toBeNull();
  });
});
