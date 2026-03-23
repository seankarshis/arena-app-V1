// ---------------------------------------------------------------------------
// Arena Draft Service — saveDraft mutation
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import { getSession, updateSession, type InterviewSession } from './session';
import {
  notFound,
  invalidState,
  validationError,
  forbidden,
} from '../middleware/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaveDraftInput {
  interviewId: string;
  content: string;
  inputMode: string;
  sttConfidenceScore?: number | null;
}

export interface SaveDraftResult {
  id: string;
  interviewId: string;
  questionId: string | null;
  draftNumber: number;
  content: string;
  inputMode: string;
  sttConfidenceScore: number | null;
  audioUploadStatus: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Allowed input modes
// ---------------------------------------------------------------------------

const VALID_INPUT_MODES = new Set(['voice', 'text', 'edited']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentQuestionId(session: InterviewSession): string | null {
  for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
    const entry = session.conversationHistory[i];
    if (entry.role === 'assistant' && entry.questionId) {
      return entry.questionId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// saveDraft
// ---------------------------------------------------------------------------

export async function saveDraft(
  prisma: PrismaClient,
  userId: string,
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  const { interviewId, content, inputMode, sttConfidenceScore } = input;

  // 1. Validate inputMode
  if (!VALID_INPUT_MODES.has(inputMode)) {
    throw validationError('Invalid input mode', {
      inputMode,
      allowedModes: 'voice, text, edited',
    });
  }

  // 2. Verify interview exists and belongs to user
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
  });

  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }

  if (interview.userId !== userId) {
    throw forbidden('Not authorized to save draft for this interview', { interviewId });
  }

  if (interview.status !== 'in_progress') {
    throw invalidState('Interview is not in progress', {
      interviewId,
      currentStatus: interview.status,
    });
  }

  // 3. Get Redis session to determine current question
  const session = await getSession(interviewId);
  if (!session) {
    throw invalidState('No active session found for interview', { interviewId });
  }

  const questionId = getCurrentQuestionId(session);

  // 4. Determine next draft_number
  const lastDraft = await prisma.responseDraft.findFirst({
    where: { interviewId, questionId },
    orderBy: { draftNumber: 'desc' },
    select: { draftNumber: true },
  });

  const draftNumber = (lastDraft?.draftNumber ?? 0) + 1;

  // 5. Determine audioUploadStatus based on inputMode
  const audioUploadStatus = inputMode === 'text' ? 'not_applicable' : 'pending';

  // 6. Create the draft record
  const draft = await prisma.responseDraft.create({
    data: {
      interviewId,
      questionId,
      draftNumber,
      content,
      inputMode,
      sttConfidenceScore: sttConfidenceScore ?? undefined,
      audioUploadStatus,
    },
  });

  // 7. Append to session's currentDrafts
  await updateSession(interviewId, {
    currentDrafts: [
      ...session.currentDrafts,
      {
        content,
        inputMode: inputMode as 'voice' | 'text',
        sttConfidenceScore: sttConfidenceScore ?? undefined,
        createdAt: new Date().toISOString(),
      },
    ],
    lastActivityAt: new Date().toISOString(),
  });

  return {
    id: draft.id,
    interviewId: draft.interviewId,
    questionId: draft.questionId,
    draftNumber: draft.draftNumber,
    content: draft.content,
    inputMode: draft.inputMode,
    sttConfidenceScore: draft.sttConfidenceScore ? Number(draft.sttConfidenceScore) : null,
    audioUploadStatus: draft.audioUploadStatus ?? audioUploadStatus,
    createdAt: draft.createdAt instanceof Date ? draft.createdAt.toISOString() : String(draft.createdAt),
  };
}

export { VALID_INPUT_MODES, getCurrentQuestionId };
