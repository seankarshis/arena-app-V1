import apolloClient from '@/lib/apolloClient';
import { gql } from '@apollo/client';

// ---------------------------------------------------------------------------
// GraphQL mutations
// ---------------------------------------------------------------------------

const REQUEST_RESPONSE_AUDIO_UPLOAD_URL = gql`
  mutation RequestResponseAudioUploadUrl($interviewId: ID!, $responseId: ID!) {
    requestResponseAudioUploadUrl(interviewId: $interviewId, responseId: $responseId) {
      presignedUrl
      s3Key
    }
  }
`;

const CONFIRM_AUDIO_UPLOAD = gql`
  mutation ConfirmAudioUpload(
    $responseId: ID!
    $s3Key: String!
    $mimeType: String!
    $durationSeconds: Float!
  ) {
    confirmAudioUpload(
      responseId: $responseId
      s3Key: $s3Key
      mimeType: $mimeType
      durationSeconds: $durationSeconds
    ) {
      success
    }
  }
`;

const REQUEST_DRAFT_AUDIO_UPLOAD_URL = gql`
  mutation RequestDraftAudioUploadUrl($interviewId: ID!, $draftId: ID!) {
    requestDraftAudioUploadUrl(interviewId: $interviewId, draftId: $draftId) {
      presignedUrl
      s3Key
    }
  }
`;

const CONFIRM_DRAFT_AUDIO_UPLOAD = gql`
  mutation ConfirmDraftAudioUpload(
    $draftId: ID!
    $s3Key: String!
    $mimeType: String!
    $durationSeconds: Float!
  ) {
    confirmDraftAudioUpload(
      draftId: $draftId
      s3Key: $s3Key
      mimeType: $mimeType
      durationSeconds: $durationSeconds
    ) {
      success
    }
  }
`;

// ---------------------------------------------------------------------------
// Mutation result types
// ---------------------------------------------------------------------------

interface ResponseAudioUrlResult {
  requestResponseAudioUploadUrl: { presignedUrl: string; s3Key: string };
}

interface DraftAudioUrlResult {
  requestDraftAudioUploadUrl: { presignedUrl: string; s3Key: string };
}

// ---------------------------------------------------------------------------
// Internal task type
// ---------------------------------------------------------------------------

interface UploadTask {
  type: 'response' | 'draft';
  interviewId: string;
  targetId: string; // responseId or draftId
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Queue class
// ---------------------------------------------------------------------------

class AudioUploadQueue {
  private pending = 0;
  private listeners = new Set<(count: number) => void>();

  private notify(): void {
    this.listeners.forEach((cb) => cb(this.pending));
  }

  /** Subscribe to pending count changes. Returns an unsubscribe function. */
  subscribe(callback: (count: number) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  getPendingCount(): number {
    return this.pending;
  }

  /**
   * Queue a committed response's audio Blob for background upload.
   * Fires requestResponseAudioUploadUrl → PUT to S3 → confirmAudioUpload.
   */
  enqueueResponseUpload(
    interviewId: string,
    responseId: string,
    blob: Blob,
    mimeType: string,
    durationSeconds: number,
  ): void {
    this.pending++;
    this.notify();
    void this.processUpload({
      type: 'response',
      interviewId,
      targetId: responseId,
      blob,
      mimeType,
      durationSeconds,
    });
  }

  /**
   * Queue a draft (redo) audio Blob for background upload.
   * Fires requestDraftAudioUploadUrl → PUT to S3 → confirmDraftAudioUpload.
   */
  enqueueDraftUpload(
    interviewId: string,
    draftId: string,
    blob: Blob,
    mimeType: string,
    durationSeconds: number,
  ): void {
    this.pending++;
    this.notify();
    void this.processUpload({
      type: 'draft',
      interviewId,
      targetId: draftId,
      blob,
      mimeType,
      durationSeconds,
    });
  }

  /**
   * Resolves true when all pending uploads complete, or false if timeoutMs
   * elapses first. Resolves immediately with true if nothing is pending.
   */
  waitForEmpty(timeoutMs: number): Promise<boolean> {
    if (this.pending === 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);

      const unsubscribe = this.subscribe((count) => {
        if (count === 0) {
          clearTimeout(timer);
          unsubscribe();
          resolve(true);
        }
      });
    });
  }

  // ---- Private ----

  private async processUpload(task: UploadTask): Promise<void> {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 1 s, 2 s, 4 s
          await sleep(1000 * Math.pow(2, attempt - 1));
        }
        await this.doUpload(task);
        this.pending--;
        this.notify();
        return;
      } catch (err) {
        console.error(
          `[audioUploadQueue] Upload attempt ${attempt + 1}/${MAX_RETRIES} failed:`,
          err,
        );
      }
    }
    console.error('[audioUploadQueue] Upload abandoned after all retries');
    this.pending--;
    this.notify();
  }

  private async doUpload(task: UploadTask): Promise<void> {
    let presignedUrl: string;
    let s3Key: string;

    if (task.type === 'response') {
      const result = await apolloClient.mutate<ResponseAudioUrlResult>({
        mutation: REQUEST_RESPONSE_AUDIO_UPLOAD_URL,
        variables: { interviewId: task.interviewId, responseId: task.targetId },
      });
      if (!result.data) throw new Error('No data from requestResponseAudioUploadUrl');
      presignedUrl = result.data.requestResponseAudioUploadUrl.presignedUrl;
      s3Key = result.data.requestResponseAudioUploadUrl.s3Key;
    } else {
      const result = await apolloClient.mutate<DraftAudioUrlResult>({
        mutation: REQUEST_DRAFT_AUDIO_UPLOAD_URL,
        variables: { interviewId: task.interviewId, draftId: task.targetId },
      });
      if (!result.data) throw new Error('No data from requestDraftAudioUploadUrl');
      presignedUrl = result.data.requestDraftAudioUploadUrl.presignedUrl;
      s3Key = result.data.requestDraftAudioUploadUrl.s3Key;
    }

    const uploadResponse = await fetch(presignedUrl, {
      method: 'PUT',
      body: task.blob,
      headers: { 'Content-Type': task.mimeType },
    });
    if (!uploadResponse.ok) {
      throw new Error(`S3 upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    if (task.type === 'response') {
      await apolloClient.mutate({
        mutation: CONFIRM_AUDIO_UPLOAD,
        variables: {
          responseId: task.targetId,
          s3Key,
          mimeType: task.mimeType,
          durationSeconds: task.durationSeconds,
        },
      });
    } else {
      await apolloClient.mutate({
        mutation: CONFIRM_DRAFT_AUDIO_UPLOAD,
        variables: {
          draftId: task.targetId,
          s3Key,
          mimeType: task.mimeType,
          durationSeconds: task.durationSeconds,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const audioUploadQueue = new AudioUploadQueue();
