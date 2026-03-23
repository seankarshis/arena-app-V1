// ---------------------------------------------------------------------------
// Unit Tests — Audio Upload Service (Presigned S3 URLs + Confirm)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requestResponseAudioUploadUrl,
  requestDraftAudioUploadUrl,
  confirmAudioUpload,
  confirmDraftAudioUpload,
  buildResponseAudioKey,
  buildDraftAudioKey,
  PRESIGN_EXPIRES_IN,
  ALLOWED_MIME_TYPES,
  MAX_DURATION_SECONDS,
  type AudioUploadDeps,
} from '../services/audioUpload';

// ---------------------------------------------------------------------------
// Mock AWS SDK
// ---------------------------------------------------------------------------

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://s3.example.com/presigned');

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

function createMockPrisma() {
  return {
    interview: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    interviewResponse: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    responseDraft: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

let mockPrisma: ReturnType<typeof createMockPrisma>;

function makeDeps(overrides?: Partial<AudioUploadDeps>): AudioUploadDeps {
  return {
    prisma: mockPrisma as unknown as AudioUploadDeps['prisma'],
    s3Client: {} as AudioUploadDeps['s3Client'],
    bucket: 'test-audio-bucket',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const USER_ID = 'user-aaa-111';
const OTHER_USER_ID = 'user-bbb-222';
const INTERVIEW_ID = 'interview-ccc-333';
const RESPONSE_ID = 'response-ddd-444';
const DRAFT_ID = 'draft-eee-555';

function mockInterview(userId = USER_ID) {
  return { id: INTERVIEW_ID, userId, status: 'in_progress' };
}

function mockResponse(interviewId = INTERVIEW_ID) {
  return {
    id: RESPONSE_ID,
    interviewId,
    interview: { userId: USER_ID },
  };
}

function mockDraft(interviewId = INTERVIEW_ID) {
  return {
    id: DRAFT_ID,
    interviewId,
    interview: { userId: USER_ID },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma = createMockPrisma();
  mockGetSignedUrl.mockResolvedValue('https://s3.example.com/presigned');
});

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

describe('buildResponseAudioKey', () => {
  it('builds correct S3 key', () => {
    expect(buildResponseAudioKey('int-1', 'resp-2')).toBe(
      'interviews/int-1/responses/resp-2/audio.webm',
    );
  });
});

describe('buildDraftAudioKey', () => {
  it('builds correct S3 key', () => {
    expect(buildDraftAudioKey('int-1', 'draft-2')).toBe(
      'interviews/int-1/drafts/draft-2/audio.webm',
    );
  });
});

// ---------------------------------------------------------------------------
// requestResponseAudioUploadUrl
// ---------------------------------------------------------------------------

describe('requestResponseAudioUploadUrl', () => {
  it('returns presigned URL and s3Key on success', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interviewResponse.findUnique.mockResolvedValue({
      id: RESPONSE_ID,
      interviewId: INTERVIEW_ID,
    });

    const result = await requestResponseAudioUploadUrl(
      makeDeps(),
      USER_ID,
      INTERVIEW_ID,
      RESPONSE_ID,
    );

    expect(result.uploadUrl).toBe('https://s3.example.com/presigned');
    expect(result.s3Key).toBe(
      `interviews/${INTERVIEW_ID}/responses/${RESPONSE_ID}/audio.webm`,
    );
    expect(result.expiresIn).toBe(PRESIGN_EXPIRES_IN);
  });

  it('calls getSignedUrl with correct bucket and key', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interviewResponse.findUnique.mockResolvedValue({
      id: RESPONSE_ID,
      interviewId: INTERVIEW_ID,
    });

    await requestResponseAudioUploadUrl(
      makeDeps(),
      USER_ID,
      INTERVIEW_ID,
      RESPONSE_ID,
    );

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(command.input).toEqual({
      Bucket: 'test-audio-bucket',
      Key: `interviews/${INTERVIEW_ID}/responses/${RESPONSE_ID}/audio.webm`,
      ContentType: 'audio/webm',
    });
    expect(options.expiresIn).toBe(PRESIGN_EXPIRES_IN);
  });

  it('throws NOT_FOUND when interview does not exist', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(null);

    await expect(
      requestResponseAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, RESPONSE_ID),
    ).rejects.toThrow('Interview not found');
  });

  it('throws NOT_FOUND when interview belongs to different user', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview(OTHER_USER_ID));

    await expect(
      requestResponseAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, RESPONSE_ID),
    ).rejects.toThrow('Interview not found');
  });

  it('throws NOT_FOUND when response does not exist', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interviewResponse.findUnique.mockResolvedValue(null);

    await expect(
      requestResponseAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, RESPONSE_ID),
    ).rejects.toThrow('Interview response not found');
  });

  it('throws INVALID_STATE when response belongs to a different interview', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interviewResponse.findUnique.mockResolvedValue({
      id: RESPONSE_ID,
      interviewId: 'other-interview',
    });

    await expect(
      requestResponseAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, RESPONSE_ID),
    ).rejects.toThrow('Response does not belong to the specified interview');
  });

  it('throws EXTERNAL_SERVICE_ERROR when bucket is not configured', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.interviewResponse.findUnique.mockResolvedValue({
      id: RESPONSE_ID,
      interviewId: INTERVIEW_ID,
    });

    const deps = makeDeps({ bucket: undefined });
    const originalEnv = process.env.S3_AUDIO_BUCKET;
    delete process.env.S3_AUDIO_BUCKET;

    try {
      await expect(
        requestResponseAudioUploadUrl(deps, USER_ID, INTERVIEW_ID, RESPONSE_ID),
      ).rejects.toThrow('S3_AUDIO_BUCKET is not configured');
    } finally {
      if (originalEnv !== undefined) {
        process.env.S3_AUDIO_BUCKET = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// requestDraftAudioUploadUrl
// ---------------------------------------------------------------------------

describe('requestDraftAudioUploadUrl', () => {
  it('returns presigned URL and s3Key on success', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.responseDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      interviewId: INTERVIEW_ID,
    });

    const result = await requestDraftAudioUploadUrl(
      makeDeps(),
      USER_ID,
      INTERVIEW_ID,
      DRAFT_ID,
    );

    expect(result.uploadUrl).toBe('https://s3.example.com/presigned');
    expect(result.s3Key).toBe(
      `interviews/${INTERVIEW_ID}/drafts/${DRAFT_ID}/audio.webm`,
    );
    expect(result.expiresIn).toBe(PRESIGN_EXPIRES_IN);
  });

  it('throws NOT_FOUND when interview does not exist', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(null);

    await expect(
      requestDraftAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, DRAFT_ID),
    ).rejects.toThrow('Interview not found');
  });

  it('throws NOT_FOUND when interview belongs to different user', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview(OTHER_USER_ID));

    await expect(
      requestDraftAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, DRAFT_ID),
    ).rejects.toThrow('Interview not found');
  });

  it('throws NOT_FOUND when draft does not exist', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.responseDraft.findUnique.mockResolvedValue(null);

    await expect(
      requestDraftAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, DRAFT_ID),
    ).rejects.toThrow('Response draft not found');
  });

  it('throws INVALID_STATE when draft belongs to a different interview', async () => {
    mockPrisma.interview.findUnique.mockResolvedValue(mockInterview());
    mockPrisma.responseDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      interviewId: 'other-interview',
    });

    await expect(
      requestDraftAudioUploadUrl(makeDeps(), USER_ID, INTERVIEW_ID, DRAFT_ID),
    ).rejects.toThrow('Draft does not belong to the specified interview');
  });
});

// ---------------------------------------------------------------------------
// confirmAudioUpload
// ---------------------------------------------------------------------------

describe('confirmAudioUpload', () => {
  const validInput = {
    s3Key: `interviews/${INTERVIEW_ID}/responses/${RESPONSE_ID}/audio.webm`,
    mimeType: 'audio/webm',
    durationSeconds: 45.5,
  };

  it('updates response record on success', async () => {
    mockPrisma.interviewResponse.findUnique.mockResolvedValue(mockResponse());
    mockPrisma.interviewResponse.update.mockResolvedValue({});

    const result = await confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, validInput);

    expect(result).toEqual({ success: true });
    expect(mockPrisma.interviewResponse.update).toHaveBeenCalledWith({
      where: { id: RESPONSE_ID },
      data: {
        s3AudioKey: validInput.s3Key,
        audioMimeType: validInput.mimeType,
        audioDurationSeconds: validInput.durationSeconds,
        audioUploadStatus: 'completed',
      },
    });
  });

  it('throws NOT_FOUND when response does not exist', async () => {
    mockPrisma.interviewResponse.findUnique.mockResolvedValue(null);

    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, validInput),
    ).rejects.toThrow('Interview response not found');
  });

  it('throws NOT_FOUND when response belongs to a different user', async () => {
    mockPrisma.interviewResponse.findUnique.mockResolvedValue({
      ...mockResponse(),
      interview: { userId: OTHER_USER_ID },
    });

    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, validInput),
    ).rejects.toThrow('Interview response not found');
  });

  it('throws VALIDATION_ERROR for unsupported MIME type', async () => {
    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        mimeType: 'video/mp4',
      }),
    ).rejects.toThrow('Unsupported audio MIME type');
  });

  it('accepts all allowed MIME types', async () => {
    for (const mimeType of ALLOWED_MIME_TYPES) {
      mockPrisma.interviewResponse.findUnique.mockResolvedValue(mockResponse());
      mockPrisma.interviewResponse.update.mockResolvedValue({});

      const result = await confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        mimeType,
      });
      expect(result).toEqual({ success: true });
    }
  });

  it('throws VALIDATION_ERROR when duration is zero', async () => {
    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        durationSeconds: 0,
      }),
    ).rejects.toThrow('Audio duration out of range');
  });

  it('throws VALIDATION_ERROR when duration is negative', async () => {
    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        durationSeconds: -1,
      }),
    ).rejects.toThrow('Audio duration out of range');
  });

  it('throws VALIDATION_ERROR when duration exceeds max', async () => {
    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        durationSeconds: MAX_DURATION_SECONDS + 1,
      }),
    ).rejects.toThrow('Audio duration out of range');
  });

  it('accepts duration at max boundary', async () => {
    mockPrisma.interviewResponse.findUnique.mockResolvedValue(mockResponse());
    mockPrisma.interviewResponse.update.mockResolvedValue({});

    const result = await confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
      ...validInput,
      durationSeconds: MAX_DURATION_SECONDS,
    });
    expect(result).toEqual({ success: true });
  });

  it('throws VALIDATION_ERROR when s3Key does not match expected prefix', async () => {
    mockPrisma.interviewResponse.findUnique.mockResolvedValue(mockResponse());

    await expect(
      confirmAudioUpload(makeDeps(), USER_ID, RESPONSE_ID, {
        ...validInput,
        s3Key: 'interviews/wrong-interview/responses/wrong-response/audio.webm',
      }),
    ).rejects.toThrow('S3 key does not match expected path for this response');
  });
});

// ---------------------------------------------------------------------------
// confirmDraftAudioUpload
// ---------------------------------------------------------------------------

describe('confirmDraftAudioUpload', () => {
  const validInput = {
    s3Key: `interviews/${INTERVIEW_ID}/drafts/${DRAFT_ID}/audio.webm`,
    mimeType: 'audio/webm',
    durationSeconds: 30,
  };

  it('updates draft record on success', async () => {
    mockPrisma.responseDraft.findUnique.mockResolvedValue(mockDraft());
    mockPrisma.responseDraft.update.mockResolvedValue({});

    const result = await confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, validInput);

    expect(result).toEqual({ success: true });
    expect(mockPrisma.responseDraft.update).toHaveBeenCalledWith({
      where: { id: DRAFT_ID },
      data: {
        s3AudioKey: validInput.s3Key,
        audioMimeType: validInput.mimeType,
        audioDurationSeconds: validInput.durationSeconds,
        audioUploadStatus: 'completed',
      },
    });
  });

  it('throws NOT_FOUND when draft does not exist', async () => {
    mockPrisma.responseDraft.findUnique.mockResolvedValue(null);

    await expect(
      confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, validInput),
    ).rejects.toThrow('Response draft not found');
  });

  it('throws NOT_FOUND when draft belongs to a different user', async () => {
    mockPrisma.responseDraft.findUnique.mockResolvedValue({
      ...mockDraft(),
      interview: { userId: OTHER_USER_ID },
    });

    await expect(
      confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, validInput),
    ).rejects.toThrow('Response draft not found');
  });

  it('throws VALIDATION_ERROR for unsupported MIME type', async () => {
    await expect(
      confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, {
        ...validInput,
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('Unsupported audio MIME type');
  });

  it('throws VALIDATION_ERROR when duration exceeds max', async () => {
    await expect(
      confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, {
        ...validInput,
        durationSeconds: MAX_DURATION_SECONDS + 100,
      }),
    ).rejects.toThrow('Audio duration out of range');
  });

  it('throws VALIDATION_ERROR when s3Key does not match expected prefix', async () => {
    mockPrisma.responseDraft.findUnique.mockResolvedValue(mockDraft());

    await expect(
      confirmDraftAudioUpload(makeDeps(), USER_ID, DRAFT_ID, {
        ...validInput,
        s3Key: 'interviews/wrong/drafts/wrong/audio.webm',
      }),
    ).rejects.toThrow('S3 key does not match expected path for this draft');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('PRESIGN_EXPIRES_IN is 300 seconds', () => {
    expect(PRESIGN_EXPIRES_IN).toBe(300);
  });

  it('MAX_DURATION_SECONDS is 360 (6 minutes)', () => {
    expect(MAX_DURATION_SECONDS).toBe(360);
  });

  it('ALLOWED_MIME_TYPES includes expected audio formats', () => {
    expect(ALLOWED_MIME_TYPES.has('audio/webm')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('audio/ogg')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('audio/wav')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('audio/mpeg')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('audio/mp4')).toBe(true);
  });
});
