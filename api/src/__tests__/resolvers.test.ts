// ---------------------------------------------------------------------------
// Arena Resolver Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers } from '../schema/resolvers';

// ---------------------------------------------------------------------------
// Mock AWS Cognito SDK (dynamic import in syncUserRole)
// ---------------------------------------------------------------------------

const mockCognitoSend = vi.fn();
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
    send: mockCognitoSend,
  })),
  AdminListGroupsForUserCommand: vi.fn().mockImplementation((args: unknown) => args),
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
      create: vi.fn().mockResolvedValue({ id: 'audit-001' }),
    },
    $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return (arg as CallableFunction)(mockPrisma);
      return arg;
    }),
  };
}

// Shared mutable reference — reassigned in beforeEach
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
    consentStatusByUserId: { load: vi.fn().mockResolvedValue({
      dataProcessing: false,
      audioRecording: false,
      aiInteraction: false,
      allGranted: false,
    }) },
    assignmentsByUserId: { load: vi.fn().mockResolvedValue([]) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

function adminCtx(): Ctx {
  const prisma = createMockPrisma();
  mockPrisma = prisma;
  // Fix $transaction to use the current prisma reference
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

function unauthCtx(): Ctx {
  const prisma = createMockPrisma();
  return { user: null, prisma, loaders: createMockLoaders() };
}

function expectGqlError(err: unknown, code: string) {
  expect(err).toBeDefined();
  const e = err as { extensions?: { code?: string } };
  expect(e.extensions?.code).toBe(code);
}

// ---------------------------------------------------------------------------
// Shortcut refs
// ---------------------------------------------------------------------------
const Q = resolvers.Query;
const M = resolvers.Mutation;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// =========================================================================
// Health
// =========================================================================
describe('Query._health', () => {
  it('returns ok', () => {
    expect(Q._health()).toBe('ok');
  });
});

// =========================================================================
// Auth enforcement
// =========================================================================
describe('Auth enforcement', () => {
  it('getTags rejects unauthenticated', async () => {
    await expect(Q.getTags({}, {}, unauthCtx())).rejects.toMatchObject({
      extensions: { code: 'UNAUTHORIZED' },
    });
  });

  it('getQuestions rejects unauthenticated', async () => {
    await expect(Q.getQuestions({}, {}, unauthCtx())).rejects.toMatchObject({
      extensions: { code: 'UNAUTHORIZED' },
    });
  });

  it('createTag rejects non-admin', async () => {
    await expect(
      M.createTag({}, { label: 'a' }, userCtx()),
    ).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('createTag rejects unauthenticated', async () => {
    await expect(
      M.createTag({}, { label: 'a' }, unauthCtx()),
    ).rejects.toMatchObject({
      extensions: { code: 'UNAUTHORIZED' },
    });
  });

  it('getDraftsForResponse rejects non-admin', async () => {
    await expect(
      Q.getDraftsForResponse({}, { interviewId: 'i', questionId: 'q' }, userCtx()),
    ).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('getTemplateAssignmentHistory rejects non-admin', async () => {
    await expect(
      Q.getTemplateAssignmentHistory({}, { userId: 'u' }, userCtx()),
    ).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('getAuditLog rejects non-admin', async () => {
    await expect(Q.getAuditLog({}, {}, userCtx())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });
});

// =========================================================================
// Query: getTags
// =========================================================================
describe('Query.getTags', () => {
  it('returns active tags by default', async () => {
    const ctx = adminCtx();
    const tags = [{ id: 't1', label: 'Backend', isActive: true }];
    ctx.prisma.tag.findMany.mockResolvedValue(tags);

    const result = await Q.getTags({}, {}, ctx);
    expect(result).toEqual(tags);
    expect(ctx.prisma.tag.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  });

  it('includes inactive when requested', async () => {
    const ctx = adminCtx();
    ctx.prisma.tag.findMany.mockResolvedValue([]);

    await Q.getTags({}, { includeInactive: true }, ctx);
    expect(ctx.prisma.tag.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { label: 'asc' },
    });
  });
});

// =========================================================================
// Query: getQuestions (paginated)
// =========================================================================
describe('Query.getQuestions', () => {
  it('returns paginated active questions', async () => {
    const ctx = adminCtx();
    const questions = [
      { id: 'q1', text: 'Q1', isActive: true },
      { id: 'q2', text: 'Q2', isActive: true },
    ];
    ctx.prisma.question.findMany.mockResolvedValue(questions);
    ctx.prisma.question.count.mockResolvedValue(2);

    const result = await Q.getQuestions({}, { first: 25 }, ctx);
    expect(result.totalCount).toBe(2);
    expect(result.edges).toHaveLength(2);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.hasPreviousPage).toBe(false);
  });

  it('detects hasNextPage when more items exist', async () => {
    const ctx = adminCtx();
    // Return 3 items when take is 2 (first=2 → take=2, fetch 3)
    const questions = [
      { id: 'q1', text: 'Q1', isActive: true },
      { id: 'q2', text: 'Q2', isActive: true },
      { id: 'q3', text: 'Q3', isActive: true },
    ];
    ctx.prisma.question.findMany.mockResolvedValue(questions);
    ctx.prisma.question.count.mockResolvedValue(5);

    const result = await Q.getQuestions({}, { first: 2 }, ctx);
    expect(result.edges).toHaveLength(2);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.totalCount).toBe(5);
  });

  it('handles cursor-based pagination with after', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([
      { id: 'q3', text: 'Q3', isActive: true },
    ]);
    ctx.prisma.question.count.mockResolvedValue(3);

    const cursor = Buffer.from('q2').toString('base64');
    const result = await Q.getQuestions({}, { first: 25, after: cursor }, ctx);
    expect(result.pageInfo.hasPreviousPage).toBe(true);
    expect(ctx.prisma.question.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'q2' },
        skip: 1,
      }),
    );
  });

  it('clamps page size to MAX_PAGE_SIZE', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    await Q.getQuestions({}, { first: 500 }, ctx);
    // take should be 101 (clamped 100 + 1 for hasNextPage check)
    expect(ctx.prisma.question.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    );
  });

  it('filters by search text', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    await Q.getQuestions({}, { filters: { searchText: 'leadership' } }, ctx);
    const callArgs = ctx.prisma.question.findMany.mock.calls[0][0];
    expect(callArgs.where.text).toEqual({ contains: 'leadership', mode: 'insensitive' });
  });

  it('filters by tag IDs', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    await Q.getQuestions({}, { filters: { tagIds: ['t1', 't2'] } }, ctx);
    const callArgs = ctx.prisma.question.findMany.mock.calls[0][0];
    expect(callArgs.where.questionTags).toEqual({
      some: { tagId: { in: ['t1', 't2'] } },
    });
  });

  it('includes inactive questions when requested', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    await Q.getQuestions({}, { includeInactive: true }, ctx);
    const callArgs = ctx.prisma.question.findMany.mock.calls[0][0];
    expect(callArgs.where.isActive).toBeUndefined();
  });
});

// =========================================================================
// Query: getUser
// =========================================================================
describe('Query.getUser', () => {
  it('returns user by id', async () => {
    const ctx = adminCtx();
    const user = { id: 'u1', name: 'Alice', email: 'alice@test.com', role: 'user' };
    ctx.prisma.user.findUnique.mockResolvedValue(user);

    const result = await Q.getUser({}, { id: 'u1' }, ctx);
    expect(result).toEqual(user);
  });

  it('returns null for non-existent user', async () => {
    const ctx = adminCtx();
    ctx.prisma.user.findUnique.mockResolvedValue(null);

    const result = await Q.getUser({}, { id: 'nope' }, ctx);
    expect(result).toBeNull();
  });
});

// =========================================================================
// Query: getMyAssignedTemplates
// =========================================================================
describe('Query.getMyAssignedTemplates', () => {
  it('returns empty for no assignments', async () => {
    const ctx = userCtx();
    ctx.prisma.userTemplate.findMany.mockResolvedValue([]);

    const result = await Q.getMyAssignedTemplates({}, {}, ctx);
    expect(result).toEqual([]);
  });

  it('returns assignments with interview status', async () => {
    const ctx = userCtx();
    const assignments = [
      { id: 'a1', templateId: 't1', userId: 'user-001', status: 'active' },
    ];
    ctx.prisma.userTemplate.findMany.mockResolvedValue(assignments);
    ctx.prisma.interview.findMany.mockResolvedValue([
      { id: 'i1', templateId: 't1', status: 'completed', createdAt: new Date() },
    ]);

    const result = await Q.getMyAssignedTemplates({}, {}, ctx);
    expect(result).toHaveLength(1);
    expect(result[0].interviewStatus).toBe('completed');
    expect(result[0].assignment).toEqual(assignments[0]);
  });

  it('returns null interview status when no interview exists', async () => {
    const ctx = userCtx();
    ctx.prisma.userTemplate.findMany.mockResolvedValue([
      { id: 'a1', templateId: 't1', userId: 'user-001', status: 'active' },
    ]);
    ctx.prisma.interview.findMany.mockResolvedValue([]);

    const result = await Q.getMyAssignedTemplates({}, {}, ctx);
    expect(result[0].interviewStatus).toBeNull();
  });
});

// =========================================================================
// Query: getInterview
// =========================================================================
describe('Query.getInterview', () => {
  it('returns interview by id', async () => {
    const ctx = userCtx();
    const interview = { id: 'i1', status: 'in_progress' };
    ctx.prisma.interview.findUnique.mockResolvedValue(interview);

    const result = await Q.getInterview({}, { id: 'i1' }, ctx);
    expect(result).toEqual(interview);
  });
});

// =========================================================================
// Query: getInterviewsByUser (paginated)
// =========================================================================
describe('Query.getInterviewsByUser', () => {
  it('returns paginated interviews', async () => {
    const ctx = adminCtx();
    const interviews = [{ id: 'i1', userId: 'u1', status: 'completed' }];
    ctx.prisma.interview.findMany.mockResolvedValue(interviews);
    ctx.prisma.interview.count.mockResolvedValue(1);

    const result = await Q.getInterviewsByUser({}, { userId: 'u1' }, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.edges).toHaveLength(1);
  });
});

// =========================================================================
// Query: getTemplate / getTemplates
// =========================================================================
describe('Query.getTemplate', () => {
  it('returns template by id', async () => {
    const ctx = adminCtx();
    const template = { id: 't1', name: 'Test', status: 'published' };
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue(template);

    const result = await Q.getTemplate({}, { id: 't1' }, ctx);
    expect(result).toEqual(template);
  });
});

describe('Query.getTemplates', () => {
  it('returns templates filtered by status', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findMany.mockResolvedValue([]);

    await Q.getTemplates({}, { status: 'published' }, ctx);
    expect(ctx.prisma.interviewTemplate.findMany).toHaveBeenCalledWith({
      where: { status: 'published' },
      orderBy: { name: 'asc' },
    });
  });

  it('returns all templates when no status filter', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findMany.mockResolvedValue([]);

    await Q.getTemplates({}, {}, ctx);
    expect(ctx.prisma.interviewTemplate.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { name: 'asc' },
    });
  });
});

// =========================================================================
// Query: getMyConsentStatus
// =========================================================================
describe('Query.getMyConsentStatus', () => {
  it('loads consent via dataloader', async () => {
    const ctx = userCtx();
    const status = {
      dataProcessing: true,
      audioRecording: true,
      aiInteraction: true,
      allGranted: true,
    };
    ctx.loaders.consentStatusByUserId.load.mockResolvedValue(status);

    const result = await Q.getMyConsentStatus({}, {}, ctx);
    expect(result).toEqual(status);
    expect(ctx.loaders.consentStatusByUserId.load).toHaveBeenCalledWith('user-001');
  });
});

// =========================================================================
// Query: getDraftsForResponse (paginated, admin only)
// =========================================================================
describe('Query.getDraftsForResponse', () => {
  it('returns paginated drafts', async () => {
    const ctx = adminCtx();
    ctx.prisma.responseDraft.findMany.mockResolvedValue([
      { id: 'd1', draftNumber: 1, content: 'draft' },
    ]);
    ctx.prisma.responseDraft.count.mockResolvedValue(1);

    const result = await Q.getDraftsForResponse(
      {},
      { interviewId: 'i1', questionId: 'q1' },
      ctx,
    );
    expect(result.totalCount).toBe(1);
    expect(result.edges).toHaveLength(1);
  });
});

// =========================================================================
// Query: getTemplateAssignmentHistory (paginated, admin only)
// =========================================================================
describe('Query.getTemplateAssignmentHistory', () => {
  it('returns paginated history', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateAssignmentHistory.findMany.mockResolvedValue([
      { id: 'h1', userId: 'u1', templateId: 't1', assignedBy: 'admin-001' },
    ]);
    ctx.prisma.templateAssignmentHistory.count.mockResolvedValue(1);

    const result = await Q.getTemplateAssignmentHistory(
      {},
      { userId: 'u1' },
      ctx,
    );
    expect(result.totalCount).toBe(1);
  });
});

// =========================================================================
// Query: getAuditLog (paginated, admin only)
// =========================================================================
describe('Query.getAuditLog', () => {
  it('returns paginated audit entries with filters', async () => {
    const ctx = adminCtx();
    ctx.prisma.adminAuditLog.findMany.mockResolvedValue([
      { id: 'al1', actorId: 'admin-001', action: 'createTag', entityType: 'Tag', entityId: 't1' },
    ]);
    ctx.prisma.adminAuditLog.count.mockResolvedValue(1);

    const result = await Q.getAuditLog(
      {},
      { entityType: 'Tag', actorId: 'admin-001' },
      ctx,
    );
    expect(result.totalCount).toBe(1);
    expect(result.edges).toHaveLength(1);
  });
});

// =========================================================================
// Mutation: createTag
// =========================================================================
describe('Mutation.createTag', () => {
  it('creates a tag', async () => {
    const ctx = adminCtx();
    const tag = { id: 't1', label: 'Backend', isActive: true };
    ctx.prisma.tag.findUnique.mockResolvedValue(null);
    ctx.prisma.tag.create.mockResolvedValue(tag);

    const result = await M.createTag({}, { label: 'Backend' }, ctx);
    expect(result).toEqual(tag);
    expect(ctx.prisma.tag.create).toHaveBeenCalledWith({
      data: { label: 'Backend' },
    });
  });

  it('fails with DUPLICATE_ENTRY for existing label', async () => {
    const ctx = adminCtx();
    ctx.prisma.tag.findUnique.mockResolvedValue({
      id: 'existing',
      label: 'Backend',
    });

    try {
      await M.createTag({}, { label: 'Backend' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'DUPLICATE_ENTRY');
    }
  });

  it('requires admin', async () => {
    await expect(
      M.createTag({}, { label: 'x' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// =========================================================================
// Mutation: updateTag
// =========================================================================
describe('Mutation.updateTag', () => {
  it('updates a tag', async () => {
    const ctx = adminCtx();
    const existing = { id: 't1', label: 'Old', isActive: true };
    const updated = { ...existing, label: 'New' };
    ctx.prisma.tag.findUnique
      .mockResolvedValueOnce(existing) // find by id
      .mockResolvedValueOnce(null); // no dup for new label
    ctx.prisma.tag.update.mockResolvedValue(updated);

    const result = await M.updateTag({}, { id: 't1', label: 'New' }, ctx);
    expect(result).toEqual(updated);
  });

  it('fails with NOT_FOUND for missing tag', async () => {
    const ctx = adminCtx();
    ctx.prisma.tag.findUnique.mockResolvedValue(null);

    try {
      await M.updateTag({}, { id: 'nope', label: 'X' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('fails with DUPLICATE_ENTRY when label conflicts', async () => {
    const ctx = adminCtx();
    ctx.prisma.tag.findUnique
      .mockResolvedValueOnce({ id: 't1', label: 'Old' })
      .mockResolvedValueOnce({ id: 't2', label: 'Taken' }); // dup

    try {
      await M.updateTag({}, { id: 't1', label: 'Taken' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'DUPLICATE_ENTRY');
    }
  });

  it('soft-deletes with isActive: false', async () => {
    const ctx = adminCtx();
    const existing = { id: 't1', label: 'Tag', isActive: true };
    ctx.prisma.tag.findUnique.mockResolvedValue(existing);
    ctx.prisma.tag.update.mockResolvedValue({ ...existing, isActive: false });

    const result = await M.updateTag({}, { id: 't1', isActive: false }, ctx);
    expect(result.isActive).toBe(false);
    expect(ctx.prisma.tag.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { isActive: false },
    });
  });
});

// =========================================================================
// Mutation: createQuestion
// =========================================================================
describe('Mutation.createQuestion', () => {
  it('creates a question without tags', async () => {
    const ctx = adminCtx();
    const question = { id: 'q1', text: 'What?', isActive: true };
    ctx.prisma.question.create.mockResolvedValue(question);

    const result = await M.createQuestion(
      {},
      { text: 'What?' },
      ctx,
    );
    expect(result).toEqual(question);
  });

  it('creates a question with tag associations', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.create.mockResolvedValue({
      id: 'q1',
      text: 'Q',
      isActive: true,
    });

    await M.createQuestion(
      {},
      { text: 'Q', tagIds: ['t1', 't2'] },
      ctx,
    );
    expect(ctx.prisma.question.create).toHaveBeenCalledWith({
      data: {
        text: 'Q',
        questionTags: {
          create: [{ tagId: 't1' }, { tagId: 't2' }],
        },
      },
    });
  });

  it('requires admin', async () => {
    await expect(
      M.createQuestion({}, { text: 'x' }, userCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

// =========================================================================
// Mutation: updateQuestion
// =========================================================================
describe('Mutation.updateQuestion', () => {
  it('updates question text', async () => {
    const ctx = adminCtx();
    const existing = { id: 'q1', text: 'Old', isActive: true };
    const updated = { id: 'q1', text: 'New', isActive: true };
    ctx.prisma.question.findUnique.mockResolvedValue(existing);
    ctx.prisma.question.update.mockResolvedValue(updated);

    const result = await M.updateQuestion(
      {},
      { id: 'q1', text: 'New' },
      ctx,
    );
    expect(result).toEqual(updated);
  });

  it('updates tags via transaction', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findUnique.mockResolvedValue({
      id: 'q1',
      text: 'Q',
    });
    const updated = { id: 'q1', text: 'Q', isActive: true };
    ctx.prisma.question.update.mockResolvedValue(updated);

    await M.updateQuestion({}, { id: 'q1', tagIds: ['t1', 't3'] }, ctx);

    expect(ctx.prisma.$transaction).toHaveBeenCalled();
    expect(ctx.prisma.questionTag.deleteMany).toHaveBeenCalledWith({
      where: { questionId: 'q1' },
    });
    expect(ctx.prisma.questionTag.createMany).toHaveBeenCalledWith({
      data: [
        { questionId: 'q1', tagId: 't1' },
        { questionId: 'q1', tagId: 't3' },
      ],
    });
  });

  it('fails with NOT_FOUND for missing question', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findUnique.mockResolvedValue(null);

    try {
      await M.updateQuestion({}, { id: 'nope', text: 'x' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('soft-deletes with isActive: false', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findUnique.mockResolvedValue({
      id: 'q1',
      text: 'Q',
      isActive: true,
    });
    ctx.prisma.question.update.mockResolvedValue({
      id: 'q1',
      text: 'Q',
      isActive: false,
    });

    const result = await M.updateQuestion({}, { id: 'q1', isActive: false }, ctx);
    expect(result.isActive).toBe(false);
  });
});

// =========================================================================
// Mutation: createTemplate
// =========================================================================
describe('Mutation.createTemplate', () => {
  it('creates a draft template', async () => {
    const ctx = adminCtx();
    const template = { id: 't1', name: 'Interview', description: 'desc', status: 'draft' };
    ctx.prisma.interviewTemplate.create.mockResolvedValue(template);

    const result = await M.createTemplate(
      {},
      { name: 'Interview', description: 'desc' },
      ctx,
    );
    expect(result).toEqual(template);
    expect(ctx.prisma.interviewTemplate.create).toHaveBeenCalledWith({
      data: { name: 'Interview', description: 'desc', systemPrompt: null, status: 'draft' },
    });
  });
});

// =========================================================================
// Mutation: updateTemplate
// =========================================================================
describe('Mutation.updateTemplate', () => {
  it('updates template name', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'Old',
      status: 'draft',
    });
    ctx.prisma.interviewTemplate.update.mockResolvedValue({
      id: 't1',
      name: 'New',
      status: 'draft',
    });

    const result = await M.updateTemplate({}, { id: 't1', name: 'New' }, ctx);
    expect(result.name).toBe('New');
  });

  it('fails with NOT_FOUND for missing template', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue(null);

    try {
      await M.updateTemplate({}, { id: 'nope', name: 'x' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('fails to publish template with zero questions', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'draft',
    });
    ctx.prisma.templateQuestion.count.mockResolvedValue(0);

    try {
      await M.updateTemplate({}, { id: 't1', status: 'published' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'INVALID_STATE');
    }
  });

  it('publishes template with questions', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'draft',
    });
    ctx.prisma.templateQuestion.count.mockResolvedValue(3);
    ctx.prisma.interviewTemplate.update.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'published',
    });

    const result = await M.updateTemplate(
      {},
      { id: 't1', status: 'published' },
      ctx,
    );
    expect(result.status).toBe('published');
  });

  it('archives a template', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'published',
    });
    ctx.prisma.interviewTemplate.update.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'archived',
    });

    const result = await M.updateTemplate(
      {},
      { id: 't1', status: 'archived' },
      ctx,
    );
    expect(result.status).toBe('archived');
  });
});

// =========================================================================
// Mutation: addQuestionToTemplate
// =========================================================================
describe('Mutation.addQuestionToTemplate', () => {
  it('adds a question to a template', async () => {
    const ctx = adminCtx();
    const tq = {
      id: 'tq1',
      templateId: 't1',
      questionId: 'q1',
      sequenceOrder: 1,
      categoryBucket: 'general',
      isRequired: true,
      followupTriggers: [],
    };
    ctx.prisma.templateQuestion.create.mockResolvedValue(tq);

    const result = await M.addQuestionToTemplate(
      {},
      {
        templateId: 't1',
        questionId: 'q1',
        sequenceOrder: 1,
        categoryBucket: 'general',
      },
      ctx,
    );
    expect(result).toEqual(tq);
  });
});

// =========================================================================
// Mutation: updateTemplateQuestion
// =========================================================================
describe('Mutation.updateTemplateQuestion', () => {
  it('updates a template question', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq1',
      sequenceOrder: 1,
      categoryBucket: 'general',
    });
    ctx.prisma.templateQuestion.update.mockResolvedValue({
      id: 'tq1',
      sequenceOrder: 2,
      categoryBucket: 'technical',
    });

    const result = await M.updateTemplateQuestion(
      {},
      { id: 'tq1', sequenceOrder: 2, categoryBucket: 'technical' },
      ctx,
    );
    expect(result.sequenceOrder).toBe(2);
  });

  it('fails with NOT_FOUND for missing template question', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue(null);

    try {
      await M.updateTemplateQuestion({}, { id: 'nope', sequenceOrder: 1 }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });
});

// =========================================================================
// Mutation: removeQuestionFromTemplate
// =========================================================================
describe('Mutation.removeQuestionFromTemplate', () => {
  it('removes a question from template', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq1',
      templateId: 't1',
      questionId: 'q1',
    });
    ctx.prisma.templateQuestion.findMany.mockResolvedValue([]); // no other questions
    ctx.prisma.templateQuestion.delete.mockResolvedValue({});

    const result = await M.removeQuestionFromTemplate({}, { id: 'tq1' }, ctx);
    expect(result).toBe(true);
    expect(ctx.prisma.templateQuestion.delete).toHaveBeenCalledWith({
      where: { id: 'tq1' },
    });
  });

  it('fails with NOT_FOUND for missing template question', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue(null);

    try {
      await M.removeQuestionFromTemplate({}, { id: 'nope' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('fails with INVALID_STATE when referenced in follow-up triggers', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq1',
      templateId: 't1',
      questionId: 'q1',
    });
    ctx.prisma.templateQuestion.findMany.mockResolvedValue([
      {
        id: 'tq2',
        templateId: 't1',
        questionId: 'q2',
        followupTriggers: [
          {
            trigger_type: 'keyword',
            suggested_followup_question_ids: ['q1'],
          },
        ],
      },
    ]);

    try {
      await M.removeQuestionFromTemplate({}, { id: 'tq1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'INVALID_STATE');
    }
  });

  it('succeeds when other questions do not reference this one in triggers', async () => {
    const ctx = adminCtx();
    ctx.prisma.templateQuestion.findUnique.mockResolvedValue({
      id: 'tq1',
      templateId: 't1',
      questionId: 'q1',
    });
    ctx.prisma.templateQuestion.findMany.mockResolvedValue([
      {
        id: 'tq2',
        templateId: 't1',
        questionId: 'q2',
        followupTriggers: [
          {
            trigger_type: 'keyword',
            suggested_followup_question_ids: ['q3'], // different question
          },
        ],
      },
    ]);
    ctx.prisma.templateQuestion.delete.mockResolvedValue({});

    const result = await M.removeQuestionFromTemplate({}, { id: 'tq1' }, ctx);
    expect(result).toBe(true);
  });
});

// =========================================================================
// Mutation: assignTemplateToUser
// =========================================================================
describe('Mutation.assignTemplateToUser', () => {
  it('assigns a published template to user', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'published',
    });
    ctx.prisma.userTemplate.findFirst.mockResolvedValue(null);
    const assignment = {
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      assignedBy: 'admin-001',
      status: 'active',
    };
    ctx.prisma.userTemplate.create.mockResolvedValue(assignment);
    ctx.prisma.templateAssignmentHistory.create.mockResolvedValue({ id: 'h1' });

    const result = await M.assignTemplateToUser(
      {},
      { userId: 'u1', templateId: 't1' },
      ctx,
    );
    expect(result).toEqual(assignment);
  });

  it('fails with NOT_FOUND if template does not exist', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue(null);

    try {
      await M.assignTemplateToUser({}, { userId: 'u1', templateId: 'nope' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('fails with INVALID_STATE if template is not published', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'draft',
    });

    try {
      await M.assignTemplateToUser({}, { userId: 'u1', templateId: 't1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'INVALID_STATE');
    }
  });

  it('fails with DUPLICATE_ENTRY if already has active assignment', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'published',
    });
    ctx.prisma.userTemplate.findFirst.mockResolvedValue({
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      status: 'active',
    });

    try {
      await M.assignTemplateToUser({}, { userId: 'u1', templateId: 't1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'DUPLICATE_ENTRY');
    }
  });

  it('re-activates a removed assignment', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewTemplate.findUnique.mockResolvedValue({
      id: 't1',
      name: 'T',
      status: 'published',
    });
    ctx.prisma.userTemplate.findFirst.mockResolvedValue({
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      status: 'removed',
    });
    const reactivated = {
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      status: 'active',
      assignedBy: 'admin-001',
    };
    ctx.prisma.userTemplate.update.mockResolvedValue(reactivated);
    ctx.prisma.templateAssignmentHistory.create.mockResolvedValue({ id: 'h2' });

    const result = await M.assignTemplateToUser(
      {},
      { userId: 'u1', templateId: 't1' },
      ctx,
    );
    expect(result).toEqual(reactivated);
    expect(ctx.prisma.userTemplate.update).toHaveBeenCalled();
  });
});

// =========================================================================
// Mutation: removeTemplateFromUser
// =========================================================================
describe('Mutation.removeTemplateFromUser', () => {
  it('removes template assignment', async () => {
    const ctx = adminCtx();
    ctx.prisma.userTemplate.findFirst.mockResolvedValue({
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      status: 'active',
    });
    ctx.prisma.interview.findFirst.mockResolvedValue(null);
    ctx.prisma.userTemplate.update.mockResolvedValue({});
    ctx.prisma.templateAssignmentHistory.updateMany.mockResolvedValue({ count: 1 });

    const result = await M.removeTemplateFromUser(
      {},
      { userId: 'u1', templateId: 't1' },
      ctx,
    );
    expect(result).toBe(true);
  });

  it('fails with NOT_FOUND if no active assignment', async () => {
    const ctx = adminCtx();
    ctx.prisma.userTemplate.findFirst.mockResolvedValue(null);

    try {
      await M.removeTemplateFromUser({}, { userId: 'u1', templateId: 't1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('fails with INVALID_STATE if user has active interview', async () => {
    const ctx = adminCtx();
    ctx.prisma.userTemplate.findFirst.mockResolvedValue({
      id: 'a1',
      userId: 'u1',
      templateId: 't1',
      status: 'active',
    });
    ctx.prisma.interview.findFirst.mockResolvedValue({
      id: 'i1',
      status: 'in_progress',
      startedAt: new Date('2026-03-22T10:00:00Z'),
      responses: [{ id: 'r1' }, { id: 'r2' }],
      template: { templateQuestions: [{ id: 'tq1' }, { id: 'tq2' }, { id: 'tq3' }, { id: 'tq4' }] },
    });

    try {
      await M.removeTemplateFromUser({}, { userId: 'u1', templateId: 't1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'INVALID_STATE');
      const details = (err as { extensions?: { details?: Record<string, unknown> } })
        .extensions?.details;
      expect(details?.interviewId).toBe('i1');
      expect(details?.status).toBe('in_progress');
      expect(details?.percentageAnswered).toBe(50);
    }
  });
});

// =========================================================================
// Mutation: syncUserRole
// =========================================================================
describe('Mutation.syncUserRole', () => {
  it('syncs user role from Cognito', async () => {
    const ctx = adminCtx();
    ctx.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'User',
      email: 'u@test.com',
      role: 'user',
    });
    mockCognitoSend.mockResolvedValue({
      Groups: [{ GroupName: 'admin' }],
    });
    ctx.prisma.user.update.mockResolvedValue({
      id: 'u1',
      name: 'User',
      email: 'u@test.com',
      role: 'admin',
    });

    const result = await M.syncUserRole({}, { userId: 'u1' }, ctx);
    expect(result.role).toBe('admin');
  });

  it('fails with NOT_FOUND for missing user', async () => {
    const ctx = adminCtx();
    ctx.prisma.user.findUnique.mockResolvedValue(null);

    try {
      await M.syncUserRole({}, { userId: 'nope' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'NOT_FOUND');
    }
  });

  it('sets role to user when no admin group', async () => {
    const ctx = adminCtx();
    ctx.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'User',
      email: 'u@test.com',
      role: 'admin',
    });
    mockCognitoSend.mockResolvedValue({ Groups: [] });
    ctx.prisma.user.update.mockResolvedValue({
      id: 'u1',
      name: 'User',
      email: 'u@test.com',
      role: 'user',
    });

    const result = await M.syncUserRole({}, { userId: 'u1' }, ctx);
    expect(result.role).toBe('user');
    expect(ctx.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: 'user' },
    });
  });

  it('throws EXTERNAL_SERVICE_ERROR on Cognito failure', async () => {
    const ctx = adminCtx();
    ctx.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'User',
      email: 'u@test.com',
      role: 'user',
    });
    mockCognitoSend.mockRejectedValue(new Error('Cognito timeout'));

    try {
      await M.syncUserRole({}, { userId: 'u1' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expectGqlError(err, 'EXTERNAL_SERVICE_ERROR');
    }
  });
});

// =========================================================================
// Mutation: grantConsent
// =========================================================================
describe('Mutation.grantConsent', () => {
  it('creates a new consent record', async () => {
    const ctx = userCtx();
    ctx.prisma.userConsentRecord.findFirst.mockResolvedValue(null);
    ctx.prisma.userConsentRecord.create.mockResolvedValue({ id: 'c1' });

    const result = await M.grantConsent(
      {},
      { consentType: 'data_processing', consentVersion: '1.0' },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.userConsentRecord.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-001',
        consentType: 'data_processing',
        consentVersion: '1.0',
      },
    });
  });

  it('returns success for already-granted same version (idempotent)', async () => {
    const ctx = userCtx();
    ctx.prisma.userConsentRecord.findFirst.mockResolvedValue({
      id: 'c1',
      consentVersion: '1.0',
    });

    const result = await M.grantConsent(
      {},
      { consentType: 'data_processing', consentVersion: '1.0' },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.userConsentRecord.create).not.toHaveBeenCalled();
  });

  it('revokes old version and creates new when version differs', async () => {
    const ctx = userCtx();
    ctx.prisma.userConsentRecord.findFirst.mockResolvedValue({
      id: 'c1',
      consentVersion: '1.0',
    });
    ctx.prisma.userConsentRecord.update.mockResolvedValue({});
    ctx.prisma.userConsentRecord.create.mockResolvedValue({ id: 'c2' });

    const result = await M.grantConsent(
      {},
      { consentType: 'data_processing', consentVersion: '2.0' },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.userConsentRecord.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(ctx.prisma.userConsentRecord.create).toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    await expect(
      M.grantConsent(
        {},
        { consentType: 'data_processing', consentVersion: '1.0' },
        unauthCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHORIZED' } });
  });
});

// =========================================================================
// Mutation: revokeConsent
// =========================================================================
describe('Mutation.revokeConsent', () => {
  it('revokes active consent', async () => {
    const ctx = userCtx();
    ctx.prisma.userConsentRecord.findFirst.mockResolvedValue({
      id: 'c1',
      consentType: 'data_processing',
    });
    ctx.prisma.userConsentRecord.update.mockResolvedValue({});

    const result = await M.revokeConsent(
      {},
      { consentType: 'data_processing' },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.userConsentRecord.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('returns success when no active consent exists', async () => {
    const ctx = userCtx();
    ctx.prisma.userConsentRecord.findFirst.mockResolvedValue(null);

    const result = await M.revokeConsent(
      {},
      { consentType: 'data_processing' },
      ctx,
    );
    expect(result).toEqual({ success: true });
  });
});

// =========================================================================
// Mutation: requestDataDeletion
// =========================================================================
describe('Mutation.requestDataDeletion', () => {
  it('returns success for authenticated user', async () => {
    const ctx = userCtx();
    const result = await M.requestDataDeletion({}, {}, ctx);
    expect(result).toEqual({ success: true });
  });

  it('requires authentication', async () => {
    await expect(
      M.requestDataDeletion({}, {}, unauthCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHORIZED' } });
  });
});

// =========================================================================
// Mutation: confirmAudioUpload
// =========================================================================
describe('Mutation.confirmAudioUpload', () => {
  it('updates response with audio metadata', async () => {
    const ctx = userCtx();
    ctx.prisma.interviewResponse.update.mockResolvedValue({});

    const result = await M.confirmAudioUpload(
      {},
      { responseId: 'r1', s3Key: 'audio/r1.webm', mimeType: 'audio/webm', durationSeconds: 42.5 },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.interviewResponse.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: {
        s3AudioKey: 'audio/r1.webm',
        audioMimeType: 'audio/webm',
        audioDurationSeconds: 42.5,
        audioUploadStatus: 'completed',
      },
    });
  });
});

// =========================================================================
// Mutation: confirmDraftAudioUpload
// =========================================================================
describe('Mutation.confirmDraftAudioUpload', () => {
  it('updates draft with audio metadata', async () => {
    const ctx = userCtx();
    ctx.prisma.responseDraft.update.mockResolvedValue({});

    const result = await M.confirmDraftAudioUpload(
      {},
      { draftId: 'd1', s3Key: 'audio/d1.webm', mimeType: 'audio/webm', durationSeconds: 10 },
      ctx,
    );
    expect(result).toEqual({ success: true });
  });
});

// =========================================================================
// Mutation: updateCleanedContent
// =========================================================================
describe('Mutation.updateCleanedContent', () => {
  it('updates response with cleaned content', async () => {
    const ctx = adminCtx();
    ctx.prisma.interviewResponse.update.mockResolvedValue({});

    const result = await M.updateCleanedContent(
      {},
      {
        interviewResponseId: 'r1',
        cleanedMarkdown: '# Clean',
        cleaningModel: 'claude-3-haiku',
      },
      ctx,
    );
    expect(result).toEqual({ success: true });
    expect(ctx.prisma.interviewResponse.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: {
        cleanedMarkdown: '# Clean',
        cleaningModel: 'claude-3-haiku',
        cleanedAt: expect.any(Date),
        processingStatus: 'completed',
      },
    });
  });
});

// =========================================================================
// Field Resolvers: Question
// =========================================================================
describe('Field: Question.tags', () => {
  it('loads tags via dataloader', async () => {
    const ctx = adminCtx();
    const tags = [{ id: 't1', label: 'Backend' }];
    ctx.loaders.tagsByQuestionId.load.mockResolvedValue(tags);

    const result = await resolvers.Question.tags({ id: 'q1' }, {}, ctx);
    expect(result).toEqual(tags);
    expect(ctx.loaders.tagsByQuestionId.load).toHaveBeenCalledWith('q1');
  });
});

// =========================================================================
// Field Resolvers: InterviewTemplate
// =========================================================================
describe('Field: InterviewTemplate.questions', () => {
  it('loads template questions via dataloader', async () => {
    const ctx = adminCtx();
    const tqs = [{ id: 'tq1', questionId: 'q1', sequenceOrder: 1 }];
    ctx.loaders.templateQuestionsByTemplateId.load.mockResolvedValue(tqs);

    const result = await resolvers.InterviewTemplate.questions({ id: 't1' }, {}, ctx);
    expect(result).toEqual(tqs);
  });
});

// =========================================================================
// Field Resolvers: TemplateQuestion
// =========================================================================
describe('Field: TemplateQuestion', () => {
  it('question loads via dataloader', async () => {
    const ctx = adminCtx();
    const question = { id: 'q1', text: 'Q' };
    ctx.loaders.questionById.load.mockResolvedValue(question);

    const result = await resolvers.TemplateQuestion.question(
      { questionId: 'q1' },
      {},
      ctx,
    );
    expect(result).toEqual(question);
  });

  it('followupTriggers returns empty array when null', () => {
    const result = resolvers.TemplateQuestion.followupTriggers({
      followupTriggers: null,
    });
    expect(result).toEqual([]);
  });

  it('followupTriggers passes through value', () => {
    const triggers = [{ questionId: 'q1', condition: 'always' }];
    const result = resolvers.TemplateQuestion.followupTriggers({
      followupTriggers: triggers,
    });
    expect(result).toEqual(triggers);
  });
});

// =========================================================================
// Field Resolvers: User
// =========================================================================
describe('Field: User', () => {
  it('assignedTemplates loads via dataloader', async () => {
    const ctx = adminCtx();
    const assignments = [{ id: 'a1', templateId: 't1' }];
    ctx.loaders.assignmentsByUserId.load.mockResolvedValue(assignments);

    const result = await resolvers.User.assignedTemplates({ id: 'u1' }, {}, ctx);
    expect(result).toEqual(assignments);
  });

  it('tags loads via dataloader', async () => {
    const ctx = adminCtx();
    ctx.loaders.tagsByUserId.load.mockResolvedValue([{ id: 't1' }]);

    const result = await resolvers.User.tags({ id: 'u1' }, {}, ctx);
    expect(result).toHaveLength(1);
  });

  it('consentStatus loads via dataloader', async () => {
    const ctx = adminCtx();
    const status = {
      dataProcessing: true,
      audioRecording: false,
      aiInteraction: true,
      allGranted: false,
    };
    ctx.loaders.consentStatusByUserId.load.mockResolvedValue(status);

    const result = await resolvers.User.consentStatus({ id: 'u1' }, {}, ctx);
    expect(result).toEqual(status);
  });
});

// =========================================================================
// Field Resolvers: UserTemplateAssignment
// =========================================================================
describe('Field: UserTemplateAssignment', () => {
  it('template loads via dataloader', async () => {
    const ctx = adminCtx();
    const template = { id: 't1', name: 'T' };
    ctx.loaders.templateById.load.mockResolvedValue(template);

    const result = await resolvers.UserTemplateAssignment.template(
      { templateId: 't1' },
      {},
      ctx,
    );
    expect(result).toEqual(template);
  });

  it('assignedAt converts Date to ISO string', () => {
    const date = new Date('2026-01-15T10:00:00Z');
    expect(resolvers.UserTemplateAssignment.assignedAt({ assignedAt: date })).toBe(
      '2026-01-15T10:00:00.000Z',
    );
  });

  it('assignedAt passes through string', () => {
    expect(
      resolvers.UserTemplateAssignment.assignedAt({ assignedAt: '2026-01-15' }),
    ).toBe('2026-01-15');
  });

  it('completedAt handles null', () => {
    expect(
      resolvers.UserTemplateAssignment.completedAt({ completedAt: null }),
    ).toBeNull();
  });

  it('completedAt converts Date', () => {
    const date = new Date('2026-02-01T12:00:00Z');
    expect(
      resolvers.UserTemplateAssignment.completedAt({ completedAt: date }),
    ).toBe('2026-02-01T12:00:00.000Z');
  });
});

// =========================================================================
// Field Resolvers: Interview
// =========================================================================
describe('Field: Interview', () => {
  it('user loads via dataloader', async () => {
    const ctx = adminCtx();
    ctx.loaders.userById.load.mockResolvedValue({ id: 'u1', name: 'Alice' });

    const result = await resolvers.Interview.user({ userId: 'u1' }, {}, ctx);
    expect(result).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('template loads via dataloader', async () => {
    const ctx = adminCtx();
    ctx.loaders.templateById.load.mockResolvedValue({ id: 't1', name: 'T' });

    const result = await resolvers.Interview.template({ templateId: 't1' }, {}, ctx);
    expect(result).toEqual({ id: 't1', name: 'T' });
  });

  it('responses loads via dataloader', async () => {
    const ctx = adminCtx();
    ctx.loaders.responsesByInterviewId.load.mockResolvedValue([{ id: 'r1' }]);

    const result = await resolvers.Interview.responses({ id: 'i1' }, {}, ctx);
    expect(result).toHaveLength(1);
  });

  it('costSummary derives from interview fields', () => {
    const result = resolvers.Interview.costSummary({
      totalLlmPromptTokens: 100,
      totalLlmCompletionTokens: 200,
      totalSttDurationSeconds: '30.50',
      totalTtsCharacters: 5000,
    });
    expect(result).toEqual({
      totalLlmPromptTokens: 100,
      totalLlmCompletionTokens: 200,
      totalSttDurationSeconds: 30.5,
      totalTtsCharacters: 5000,
    });
  });

  it('startedAt converts Date', () => {
    const d = new Date('2026-03-22T10:00:00Z');
    expect(resolvers.Interview.startedAt({ startedAt: d })).toBe(
      '2026-03-22T10:00:00.000Z',
    );
  });

  it('startedAt handles null', () => {
    expect(resolvers.Interview.startedAt({ startedAt: null })).toBeNull();
  });
});

// =========================================================================
// Field Resolvers: InterviewResponse
// =========================================================================
describe('Field: InterviewResponse', () => {
  it('audioMetadata returns null when no audio key', () => {
    const result = resolvers.InterviewResponse.audioMetadata({
      s3AudioKey: null,
      audioMimeType: null,
      audioDurationSeconds: null,
    });
    expect(result).toBeNull();
  });

  it('audioMetadata returns structured data when audio exists', () => {
    const result = resolvers.InterviewResponse.audioMetadata({
      s3AudioKey: 'audio/r1.webm',
      audioMimeType: 'audio/webm',
      audioDurationSeconds: '42.50',
    });
    expect(result).toEqual({
      s3Key: 'audio/r1.webm',
      mimeType: 'audio/webm',
      durationSeconds: 42.5,
    });
  });

  it('respondedAt converts Date', () => {
    const d = new Date('2026-03-22T14:30:00Z');
    expect(resolvers.InterviewResponse.respondedAt({ respondedAt: d })).toBe(
      '2026-03-22T14:30:00.000Z',
    );
  });
});

// =========================================================================
// Field Resolvers: ResponseDraft
// =========================================================================
describe('Field: ResponseDraft', () => {
  it('createdAt converts Date', () => {
    const d = new Date('2026-03-22T08:00:00Z');
    expect(resolvers.ResponseDraft.createdAt({ createdAt: d })).toBe(
      '2026-03-22T08:00:00.000Z',
    );
  });

  it('sttConfidenceScore converts Decimal to number', () => {
    expect(
      resolvers.ResponseDraft.sttConfidenceScore({ sttConfidenceScore: '0.9523' }),
    ).toBeCloseTo(0.9523);
  });

  it('sttConfidenceScore returns null when absent', () => {
    expect(
      resolvers.ResponseDraft.sttConfidenceScore({ sttConfidenceScore: null }),
    ).toBeNull();
  });
});

// =========================================================================
// Field Resolvers: TemplateAssignmentRecord
// =========================================================================
describe('Field: TemplateAssignmentRecord', () => {
  it('assignedAt converts Date', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(resolvers.TemplateAssignmentRecord.assignedAt({ assignedAt: d })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('unassignedAt handles null', () => {
    expect(
      resolvers.TemplateAssignmentRecord.unassignedAt({ unassignedAt: null }),
    ).toBeNull();
  });
});

// =========================================================================
// Field Resolvers: AuditLogEntry
// =========================================================================
describe('Field: AuditLogEntry', () => {
  it('actorName loads via dataloader', async () => {
    const ctx = adminCtx();
    ctx.loaders.userById.load.mockResolvedValue({ id: 'u1', name: 'Admin' });

    const result = await resolvers.AuditLogEntry.actorName(
      { actorId: 'u1' },
      {},
      ctx,
    );
    expect(result).toBe('Admin');
  });

  it('actorName returns null when user not found', async () => {
    const ctx = adminCtx();
    ctx.loaders.userById.load.mockResolvedValue(null);

    const result = await resolvers.AuditLogEntry.actorName(
      { actorId: 'deleted' },
      {},
      ctx,
    );
    expect(result).toBeNull();
  });

  it('createdAt converts Date', () => {
    const d = new Date('2026-03-22T12:00:00Z');
    expect(resolvers.AuditLogEntry.createdAt({ createdAt: d })).toBe(
      '2026-03-22T12:00:00.000Z',
    );
  });
});

// =========================================================================
// Pagination edge cases
// =========================================================================
describe('Pagination edge cases', () => {
  it('empty result set returns proper connection', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    const result = await Q.getQuestions({}, {}, ctx);
    expect(result.edges).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    });
  });

  it('default page size is 25', async () => {
    const ctx = adminCtx();
    ctx.prisma.question.findMany.mockResolvedValue([]);
    ctx.prisma.question.count.mockResolvedValue(0);

    await Q.getQuestions({}, {}, ctx);
    expect(ctx.prisma.question.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 26 }), // 25 + 1
    );
  });

  it('cursors are base64 encoded ids', async () => {
    const ctx = adminCtx();
    const q = { id: 'test-uuid-123', text: 'Q', isActive: true };
    ctx.prisma.question.findMany.mockResolvedValue([q]);
    ctx.prisma.question.count.mockResolvedValue(1);

    const result = await Q.getQuestions({}, {}, ctx);
    const expectedCursor = Buffer.from('test-uuid-123').toString('base64');
    expect(result.edges[0].cursor).toBe(expectedCursor);
    expect(result.pageInfo.startCursor).toBe(expectedCursor);
    expect(result.pageInfo.endCursor).toBe(expectedCursor);
  });
});
