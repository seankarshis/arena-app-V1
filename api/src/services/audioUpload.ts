// ---------------------------------------------------------------------------
// Arena Audio Upload Service — Presigned S3 URLs + Confirm Uploads
// ---------------------------------------------------------------------------

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PrismaClient } from '@prisma/client';
import {
  notFound,
  invalidState,
  validationError,
  externalServiceError,
} from '../middleware/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioUploadUrlResult {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

export interface ConfirmAudioInput {
  s3Key: string;
  mimeType: string;
  durationSeconds: number;
}

export interface AudioUploadDeps {
  prisma: PrismaClient;
  s3Client?: S3Client;
  bucket?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESIGN_EXPIRES_IN = 300; // 5 minutes
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
]);
const MAX_DURATION_SECONDS = 360; // 6 minutes (5-min cap + safety margin)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getBucket(deps: AudioUploadDeps): string {
  const bucket = deps.bucket ?? process.env.S3_AUDIO_BUCKET;
  if (!bucket) {
    throw externalServiceError('S3_AUDIO_BUCKET is not configured');
  }
  return bucket;
}

function getS3Client(deps: AudioUploadDeps): S3Client {
  return (
    deps.s3Client ??
    new S3Client({
      region: process.env.AWS_REGION || 'us-east-2',
    })
  );
}

function buildResponseAudioKey(interviewId: string, responseId: string): string {
  return `interviews/${interviewId}/responses/${responseId}/audio.webm`;
}

function buildDraftAudioKey(interviewId: string, draftId: string): string {
  return `interviews/${interviewId}/drafts/${draftId}/audio.webm`;
}

function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw validationError('Unsupported audio MIME type', { mimeType });
  }
}

function validateDuration(durationSeconds: number): void {
  if (durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw validationError('Audio duration out of range', {
      durationSeconds,
      maxDurationSeconds: MAX_DURATION_SECONDS,
    });
  }
}

// ---------------------------------------------------------------------------
// Presigned URL generation
// ---------------------------------------------------------------------------

export async function requestResponseAudioUploadUrl(
  deps: AudioUploadDeps,
  userId: string,
  interviewId: string,
  responseId: string,
): Promise<AudioUploadUrlResult> {
  const { prisma } = deps;

  // Verify the interview exists and belongs to this user
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
  });
  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }
  if (interview.userId !== userId) {
    throw notFound('Interview not found', { interviewId });
  }

  // Verify the response exists and belongs to this interview
  const response = await prisma.interviewResponse.findUnique({
    where: { id: responseId },
  });
  if (!response) {
    throw notFound('Interview response not found', { responseId });
  }
  if (response.interviewId !== interviewId) {
    throw invalidState('Response does not belong to the specified interview', {
      responseId,
      interviewId,
    });
  }

  const bucket = getBucket(deps);
  const s3Key = buildResponseAudioKey(interviewId, responseId);
  const s3Client = getS3Client(deps);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: 'audio/webm',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: PRESIGN_EXPIRES_IN,
  });

  return { uploadUrl, s3Key, expiresIn: PRESIGN_EXPIRES_IN };
}

export async function requestDraftAudioUploadUrl(
  deps: AudioUploadDeps,
  userId: string,
  interviewId: string,
  draftId: string,
): Promise<AudioUploadUrlResult> {
  const { prisma } = deps;

  // Verify the interview exists and belongs to this user
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
  });
  if (!interview) {
    throw notFound('Interview not found', { interviewId });
  }
  if (interview.userId !== userId) {
    throw notFound('Interview not found', { interviewId });
  }

  // Verify the draft exists and belongs to this interview
  const draft = await prisma.responseDraft.findUnique({
    where: { id: draftId },
  });
  if (!draft) {
    throw notFound('Response draft not found', { draftId });
  }
  if (draft.interviewId !== interviewId) {
    throw invalidState('Draft does not belong to the specified interview', {
      draftId,
      interviewId,
    });
  }

  const bucket = getBucket(deps);
  const s3Key = buildDraftAudioKey(interviewId, draftId);
  const s3Client = getS3Client(deps);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: 'audio/webm',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: PRESIGN_EXPIRES_IN,
  });

  return { uploadUrl, s3Key, expiresIn: PRESIGN_EXPIRES_IN };
}

// ---------------------------------------------------------------------------
// Confirm uploads
// ---------------------------------------------------------------------------

export async function confirmAudioUpload(
  deps: AudioUploadDeps,
  userId: string,
  responseId: string,
  input: ConfirmAudioInput,
): Promise<{ success: true }> {
  const { prisma } = deps;

  validateMimeType(input.mimeType);
  validateDuration(input.durationSeconds);

  const response = await prisma.interviewResponse.findUnique({
    where: { id: responseId },
    include: { interview: { select: { userId: true } } },
  });
  if (!response) {
    throw notFound('Interview response not found', { responseId });
  }
  if (response.interview.userId !== userId) {
    throw notFound('Interview response not found', { responseId });
  }

  // Validate the s3Key matches expected pattern
  const expectedPrefix = `interviews/${response.interviewId}/responses/${responseId}/`;
  if (!input.s3Key.startsWith(expectedPrefix)) {
    throw validationError('S3 key does not match expected path for this response', {
      responseId,
    });
  }

  await prisma.interviewResponse.update({
    where: { id: responseId },
    data: {
      s3AudioKey: input.s3Key,
      audioMimeType: input.mimeType,
      audioDurationSeconds: input.durationSeconds,
      audioUploadStatus: 'completed',
    },
  });

  return { success: true };
}

export async function confirmDraftAudioUpload(
  deps: AudioUploadDeps,
  userId: string,
  draftId: string,
  input: ConfirmAudioInput,
): Promise<{ success: true }> {
  const { prisma } = deps;

  validateMimeType(input.mimeType);
  validateDuration(input.durationSeconds);

  const draft = await prisma.responseDraft.findUnique({
    where: { id: draftId },
    include: { interview: { select: { userId: true } } },
  });
  if (!draft) {
    throw notFound('Response draft not found', { draftId });
  }
  if (draft.interview.userId !== userId) {
    throw notFound('Response draft not found', { draftId });
  }

  // Validate the s3Key matches expected pattern
  const expectedPrefix = `interviews/${draft.interviewId}/drafts/${draftId}/`;
  if (!input.s3Key.startsWith(expectedPrefix)) {
    throw validationError('S3 key does not match expected path for this draft', {
      draftId,
    });
  }

  await prisma.responseDraft.update({
    where: { id: draftId },
    data: {
      s3AudioKey: input.s3Key,
      audioMimeType: input.mimeType,
      audioDurationSeconds: input.durationSeconds,
      audioUploadStatus: 'completed',
    },
  });

  return { success: true };
}

// Export constants for testing
export { PRESIGN_EXPIRES_IN, ALLOWED_MIME_TYPES, MAX_DURATION_SECONDS };
export { buildResponseAudioKey, buildDraftAudioKey };
