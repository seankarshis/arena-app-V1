// ---------------------------------------------------------------------------
// Arena Interview Session Service
// startInterview, pauseInterview, resumeInterview
// ---------------------------------------------------------------------------

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  setSessionPausedTTL,
  refreshSessionTTL,
  buildInitialSession,
  ACTIVE_SESSION_TTL,
  type InterviewSession,
} from './session';
import {
  notFound,
  invalidState,
  consentRequired,
  forbidden,
} from '../middleware/errors';
import { clickHouseWrite } from '../observability/clickhouseWriter';

// ---------------------------------------------------------------------------
// Required consent types that must be granted before starting an interview
// ---------------------------------------------------------------------------

const REQUIRED_CONSENT_TYPES = [
  'data_processing',
  'audio_recording',
  'ai_interaction',
];

// ---------------------------------------------------------------------------
// startInterview
// ---------------------------------------------------------------------------

export async function startInterview(
  prisma: PrismaClient,
  userId: string,
  templateId: string,
): Promise<{ id: string; userId: string; templateId: string; status: string; startedAt: string }> {
  // 1. Verify consent (unless bypassed)
  if (process.env.CONSENT_BYPASS !== 'true') {
    const consentRecords = await prisma.userConsentRecord.findMany({
      where: { userId, revokedAt: null },
    });
    const grantedTypes = new Set(consentRecords.map((r: { consentType: string }) => r.consentType));
    const missing = REQUIRED_CONSENT_TYPES.filter((t) => !grantedTypes.has(t));
    if (missing.length > 0) {
      throw consentRequired('All required consent types must be granted before starting an interview', {
        missingConsentTypes: missing.join(', '),
      });
    }
  }

  // 2. Verify active template assignment via user_templates
  const assignment = await prisma.userTemplate.findFirst({
    where: { userId, templateId, status: 'active' },
  });
  if (!assignment) {
    throw forbidden('User does not have an active assignment for this template', {
      userId,
      templateId,
    });
  }

  // 3. Verify template is published
  const template = await prisma.interviewTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template) {
    throw notFound('Template not found', { templateId });
  }
  if (template.status !== 'published') {
    throw invalidState('Template is not published', {
      templateId,
      templateStatus: template.status,
    });
  }

  // 4. Check no existing in_progress or paused interview for this user
  const existingInterview = await prisma.interview.findFirst({
    where: { userId, status: { in: ['in_progress', 'paused'] } },
  });
  if (existingInterview) {
    throw invalidState('User already has an active interview', {
      existingInterviewId: existingInterview.id,
      existingStatus: existingInterview.status,
    });
  }

  // 5. Fetch template questions ordered by sequence_order
  const templateQuestions = await prisma.templateQuestion.findMany({
    where: { templateId },
    orderBy: { sequenceOrder: 'asc' },
  });

  if (templateQuestions.length === 0) {
    throw invalidState('Template has no questions', { templateId });
  }

  // 6. Separate required vs optional and collect bucket names
  const requiredQuestionIds: string[] = [];
  const optionalQuestionIds: string[] = [];
  const bucketNames = new Set<string>();

  for (const tq of templateQuestions) {
    if (tq.isRequired) {
      requiredQuestionIds.push(tq.questionId);
    } else {
      optionalQuestionIds.push(tq.questionId);
    }
    bucketNames.add(tq.categoryBucket);
  }

  // 7. Create interview DB record
  const now = new Date();
  const interview = await prisma.interview.create({
    data: {
      userId,
      templateId,
      status: 'in_progress',
      startedAt: now,
    },
  });

  // 8. Initialize Redis session
  const session = buildInitialSession({
    interviewId: interview.id,
    templateId,
    userId,
    requiredQuestionIds,
    optionalQuestionIds,
    totalExpectedQuestions: templateQuestions.length,
    bucketNames: Array.from(bucketNames),
  });

  await createSession(session);

  clickHouseWrite('interview_lifecycle', {
    interviewId: interview.id,
    templateId,
    event: 'started',
    requiredQuestionCount: requiredQuestionIds.length,
    optionalQuestionCount: optionalQuestionIds.length,
  });

  return {
    id: interview.id,
    userId: interview.userId,
    templateId: interview.templateId,
    status: interview.status,
    startedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// abandonInterview
// ---------------------------------------------------------------------------

export async function abandonInterview(
  prisma: PrismaClient,
  userId: string,
  interviewId: string,
): Promise<{ id: string; userId: string; templateId: string; status: string }> {
  const interview = await prisma.interview.findUnique({ where: { id: interviewId } });

  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }

  if (interview.userId !== userId) {
    throw forbidden('Not authorized to abandon this interview', { interviewId });
  }

  if (interview.status !== 'in_progress' && interview.status !== 'paused') {
    throw invalidState('Interview cannot be abandoned — it is not active', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  const updated = await prisma.interview.update({
    where: { id: interviewId },
    data: { status: 'abandoned' },
  });

  // Clean up Redis session if present — non-fatal if missing
  try {
    await deleteSession(interviewId);
  } catch {
    // Session TTL will expire naturally
  }

  clickHouseWrite('interview_lifecycle', {
    interviewId,
    templateId: interview.templateId,
    event: 'abandoned',
  });

  return {
    id: updated.id,
    userId: updated.userId,
    templateId: updated.templateId,
    status: updated.status,
  };
}

// ---------------------------------------------------------------------------
// pauseInterview
// ---------------------------------------------------------------------------

export async function pauseInterview(
  prisma: PrismaClient,
  userId: string,
  interviewId: string,
): Promise<{ id: string; status: string; pausedAt: string }> {
  // 1. Fetch and validate interview
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
  });

  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }

  if (interview.userId !== userId) {
    throw forbidden('Not authorized to pause this interview', { interviewId });
  }

  if (interview.status !== 'in_progress') {
    throw invalidState('Interview is not in progress', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 2. Snapshot Redis session to DB
  const session = await getSession(interviewId);
  const now = new Date();

  const updated = await prisma.interview.update({
    where: { id: interviewId },
    data: {
      status: 'paused',
      pausedAt: now,
      sessionSnapshot: session ? (session as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  // 3. Set Redis TTL to 15 minutes (keep warm for quick resume)
  if (session) {
    await setSessionPausedTTL(interviewId);
  }

  return {
    id: updated.id,
    status: updated.status,
    pausedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// resumeInterview
// ---------------------------------------------------------------------------

export async function resumeInterview(
  prisma: PrismaClient,
  userId: string,
  interviewId: string,
): Promise<{ id: string; status: string; resumedFromSnapshot: boolean }> {
  // 1. Fetch and validate interview
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
  });

  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }

  if (interview.userId !== userId) {
    throw forbidden('Not authorized to resume this interview', { interviewId });
  }

  if (interview.status !== 'paused') {
    throw invalidState('Interview is not paused', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 2. Check Redis for warm session
  let session = await getSession(interviewId);
  let resumedFromSnapshot = false;

  if (!session) {
    // 3. Cold resume: reconstruct from DB snapshot
    const snapshot = interview.sessionSnapshot as unknown as InterviewSession | null;
    if (!snapshot) {
      throw invalidState('No session snapshot available for resume', { interviewId });
    }

    // Belt and suspenders: merge any responses written since the snapshot
    const responses = await prisma.interviewResponse.findMany({
      where: { interviewId },
      orderBy: { sequenceNumber: 'asc' },
    });

    // Rebuild questionsAsked and questionsCompleted from DB responses
    const questionsAskedFromDb = responses
      .filter((r: { isSkipped: boolean }) => !r.isSkipped)
      .map((r: { questionId: string }) => r.questionId);
    const questionsSkippedFromDb = responses
      .filter((r: { isSkipped: boolean }) => r.isSkipped)
      .map((r: { questionId: string }) => r.questionId);

    // Merge: use snapshot but update question tracking from DB
    const allAnsweredOrSkipped = new Set([...questionsAskedFromDb, ...questionsSkippedFromDb]);
    const requiredRemaining = snapshot.requiredRemaining.filter(
      (qId: string) => !allAnsweredOrSkipped.has(qId),
    );
    const optionalRemaining = snapshot.optionalRemaining.filter(
      (qId: string) => !allAnsweredOrSkipped.has(qId),
    );

    session = {
      ...snapshot,
      questionsAsked: Array.from(new Set([...snapshot.questionsAsked, ...questionsAskedFromDb])),
      questionsSkipped: Array.from(new Set([...snapshot.questionsSkipped, ...questionsSkippedFromDb])),
      questionsCompleted: questionsAskedFromDb.length,
      requiredRemaining,
      optionalRemaining,
      lastActivityAt: new Date().toISOString(),
      idleWarningShown: false,
      isStreaming: false,
      currentTurnLlmText: null,
    };

    // Write reconstructed session to Redis
    await createSession(session);
    resumedFromSnapshot = true;
  } else {
    // Warm resume: refresh TTL back to active TTL
    await refreshSessionTTL(interviewId, ACTIVE_SESSION_TTL);

    // Update activity timestamp
    await updateSession(interviewId, {
      lastActivityAt: new Date().toISOString(),
      idleWarningShown: false,
    });
  }

  // 4. Update DB status
  await prisma.interview.update({
    where: { id: interviewId },
    data: {
      status: 'in_progress',
      pausedAt: null,
    },
  });

  return {
    id: interviewId,
    status: 'in_progress',
    resumedFromSnapshot,
  };
}
