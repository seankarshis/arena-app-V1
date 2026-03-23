// ---------------------------------------------------------------------------
// STT WebSocket Proxy — /stt
//
// Authenticates the WebSocket upgrade request via Cognito JWT (query param),
// verifies interview ownership, then:
//   - In mock mode (ELEVENLABS_MOCK=true): returns canned partial/final
//     transcripts without connecting to ElevenLabs.
//   - In real mode: proxies binary audio frames to ElevenLabs STT WebSocket
//     with burst metering (1.5× real-time relay during the initial flush),
//     streams partial and final transcripts back to the client, and updates
//     the Redis transcript buffer on each final transcript.
//
// @fastify/websocket v8 passes a SocketStream (Duplex) as the first handler
// argument. The raw WebSocket lives at connection.socket.
// ---------------------------------------------------------------------------

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import WebSocket from 'ws';
import { Duplex } from 'stream';
import { PrismaClient } from '@prisma/client';
import { verifyToken, getBypassUser } from '../middleware/auth';
import { updateSession } from '../services/session';

// ─── Fastify type augmentation ────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    sttContext?: {
      userId: string;
      interviewId: string;
    };
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** ElevenLabs real-time STT WebSocket endpoint. Verify against current docs during deployment. */
const ELEVENLABS_STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/ws';

/** Safety limit per spec: close after 6 minutes (5-min cap + 1-min backend margin). */
const MAX_SESSION_MS = 6 * 60 * 1000;

/** Assumed audio bitrate for burst-phase metering: WebM/Opus at 64 kbps ≈ 8 000 bytes/sec. */
const AUDIO_BYTES_PER_SEC = 8_000;

/** Forward buffered audio at 1.5× real-time during burst phase. */
const BURST_RATE_MULTIPLIER = 1.5;

/** How often the relay buffer drain tick fires (ms). */
const DRAIN_INTERVAL_MS = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SttProxyOptions {
  /** Prisma client to use. If omitted a default singleton is created. */
  prisma?: PrismaClient;
}

type ServerMessage =
  | { type: 'session_ready' }
  | { type: 'partial_transcript'; text: string }
  | { type: 'final_transcript'; text: string }
  | { type: 'error'; code: string; message: string };

interface ElevenLabsResponse {
  text?: string;
  /** ElevenLabs may use camelCase or snake_case for the finality flag. */
  isFinal?: boolean;
  is_final?: boolean;
  speech_final?: boolean;
}

/**
 * @fastify/websocket v8 SocketStream: a Duplex wrapping the underlying WebSocket.
 * The raw WebSocket is at connection.socket.
 */
interface SocketStream extends Duplex {
  socket: WebSocket;
}

// ─── RelayBuffer ─────────────────────────────────────────────────────────────

/**
 * Implements the burst-handling protocol from conversation-protocol-spec.md §2.
 *
 * When the frontend opens a new STT WebSocket it immediately flushes all audio
 * accumulated during the handshake. Forwarding that burst at full speed can
 * confuse the ElevenLabs STT pipeline. This class meters the initial burst at
 * 1.5× real-time, only forwarding a chunk once the accumulated time-budget
 * covers its full byte length. Switches to pass-through once the buffer drains.
 *
 * Exported for unit testing.
 */
export class RelayBuffer {
  private buffer: Buffer[] = [];
  private inBurstPhase = true;
  private readonly startTime: number;
  private bytesSent = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onForward: (chunk: Buffer) => void) {
    this.startTime = Date.now();
    this.drainTimer = setInterval(() => this.tick(), DRAIN_INTERVAL_MS);
  }

  /**
   * Submit an audio chunk. In burst phase it is queued; in pass-through it is
   * forwarded immediately.
   */
  push(chunk: Buffer): void {
    if (!this.inBurstPhase) {
      this.onForward(chunk);
      return;
    }
    this.buffer.push(chunk);
  }

  /**
   * Drain-tick: forward buffered chunks as long as the current time-budget
   * covers the next chunk's full byte length.
   */
  private tick(): void {
    if (!this.inBurstPhase || this.buffer.length === 0) return;

    while (this.buffer.length > 0) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      const budget = elapsed * AUDIO_BYTES_PER_SEC * BURST_RATE_MULTIPLIER - this.bytesSent;

      // Only forward once the budget fully covers the next chunk.
      if (budget < this.buffer[0].length) break;

      const chunk = this.buffer.shift()!;
      this.onForward(chunk);
      this.bytesSent += chunk.length;
    }

    if (this.buffer.length === 0) {
      this.inBurstPhase = false;
    }
  }

  /**
   * Stop the metering timer and flush any remaining buffered chunks
   * immediately. Call this when the client signals audio_end or the session
   * closes.
   */
  destroy(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    for (const chunk of this.buffer) {
      this.onForward(chunk);
    }
    this.buffer = [];
    this.inBurstPhase = false;
  }

  get isBursting(): boolean {
    return this.inBurstPhase;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendToClient(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function updateTranscriptBuffer(interviewId: string, text: string): Promise<void> {
  try {
    await updateSession(interviewId, { currentTranscriptBuffer: text });
  } catch {
    // Non-fatal: if Redis is unavailable the STT session continues uninterrupted.
  }
}

// ─── Mock STT session ─────────────────────────────────────────────────────────

const MOCK_PARTIALS = [
  'I have extensive',
  'I have extensive experience',
  'I have extensive experience working in',
] as const;

const MOCK_FINAL_TRANSCRIPT =
  'I have extensive experience working in fast-paced environments.';

function handleMockSession(
  socket: WebSocket,
  interviewId: string,
  sessionTimeout: ReturnType<typeof setTimeout>,
): void {
  let partialIdx = 0;
  let partialTimer: ReturnType<typeof setInterval> | null = null;
  let audioStarted = false;

  const cleanup = (): void => {
    clearTimeout(sessionTimeout);
    if (partialTimer !== null) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  };

  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      // Start emitting mock partials on first audio chunk.
      if (!audioStarted) {
        audioStarted = true;
        partialTimer = setInterval(() => {
          if (partialIdx < MOCK_PARTIALS.length) {
            sendToClient(socket, {
              type: 'partial_transcript',
              text: MOCK_PARTIALS[partialIdx++],
            });
          }
        }, 200);
      }
    } else {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'audio_end') {
          if (partialTimer !== null) {
            clearInterval(partialTimer);
            partialTimer = null;
          }
          sendToClient(socket, {
            type: 'final_transcript',
            text: MOCK_FINAL_TRANSCRIPT,
          });
          void updateTranscriptBuffer(interviewId, MOCK_FINAL_TRANSCRIPT);
        }
      } catch {
        // Ignore malformed text messages.
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ─── ElevenLabs proxy session ─────────────────────────────────────────────────

async function handleElevenLabsProxy(
  socket: WebSocket,
  interviewId: string,
  sessionTimeout: ReturnType<typeof setTimeout>,
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? '';

  let elSocket: WebSocket | null = null;
  let relayBuffer: RelayBuffer | null = null;

  const cleanup = (): void => {
    clearTimeout(sessionTimeout);
    relayBuffer?.destroy();
    relayBuffer = null;
    if (elSocket !== null && elSocket.readyState !== WebSocket.CLOSED) {
      elSocket.close();
    }
    elSocket = null;
  };

  // Open ElevenLabs connection.
  try {
    elSocket = new WebSocket(ELEVENLABS_STT_URL, {
      headers: { 'xi-api-key': apiKey },
    });
  } catch {
    sendToClient(socket, {
      type: 'error',
      code: 'EXTERNAL_SERVICE_ERROR',
      message: 'Failed to initiate STT service connection',
    });
    clearTimeout(sessionTimeout);
    if (socket.readyState === WebSocket.OPEN) socket.close();
    return;
  }

  // Forward ElevenLabs transcript events → client.
  elSocket.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as ElevenLabsResponse;
      if (!msg.text) return;

      const isFinal =
        msg.isFinal === true || msg.is_final === true || msg.speech_final === true;

      if (isFinal) {
        sendToClient(socket, { type: 'final_transcript', text: msg.text });
        void updateTranscriptBuffer(interviewId, msg.text);
      } else {
        sendToClient(socket, { type: 'partial_transcript', text: msg.text });
      }
    } catch {
      // Ignore malformed ElevenLabs messages.
    }
  });

  elSocket.on('error', () => {
    sendToClient(socket, {
      type: 'error',
      code: 'EXTERNAL_SERVICE_ERROR',
      message: 'STT service connection error',
    });
    cleanup();
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });

  elSocket.on('close', cleanup);

  // Wait for the ElevenLabs WebSocket to open.
  try {
    await new Promise<void>((resolve, reject) => {
      elSocket!.once('open', resolve);
      elSocket!.once('error', reject);
    });
  } catch {
    sendToClient(socket, {
      type: 'error',
      code: 'EXTERNAL_SERVICE_ERROR',
      message: 'STT service unavailable',
    });
    cleanup();
    if (socket.readyState === WebSocket.OPEN) socket.close();
    return;
  }

  // Send begin_stream configuration.
  // NOTE: Verify exact field names and values against current ElevenLabs docs.
  elSocket.send(
    JSON.stringify({
      type: 'begin_stream',
      audio_format: 'webm_opus',
      sample_rate: 16_000,
      channels: 1,
    }),
  );

  // Attach relay buffer for burst metering.
  relayBuffer = new RelayBuffer((chunk) => {
    if (elSocket?.readyState === WebSocket.OPEN) {
      elSocket.send(chunk);
    }
  });

  // Handle incoming client messages (audio chunks + audio_end signal).
  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      relayBuffer?.push(chunk);
    } else {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'audio_end') {
          // Flush the relay buffer then signal end-of-stream to ElevenLabs.
          relayBuffer?.destroy();
          relayBuffer = null;
          if (elSocket?.readyState === WebSocket.OPEN) {
            elSocket.send(JSON.stringify({ type: 'end_stream' }));
          }
        }
      } catch {
        // Ignore malformed text messages.
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ─── Default Prisma singleton ─────────────────────────────────────────────────

let _defaultPrisma: PrismaClient | null = null;

function getDefaultPrisma(): PrismaClient {
  if (_defaultPrisma === null) {
    _defaultPrisma = new PrismaClient();
  }
  return _defaultPrisma;
}

// ─── Fastify plugin ───────────────────────────────────────────────────────────

export const sttProxy: FastifyPluginAsync<SttProxyOptions> = async (fastify, opts) => {
  const prisma = opts.prisma ?? getDefaultPrisma();

  // Register @fastify/websocket if the decorator isn't already present
  // (guards against double-registration when sttProxy is composed with other plugins).
  if (!fastify.hasDecorator('websocketServer')) {
    await fastify.register(websocketPlugin);
  }

  /**
   * preHandler: authenticate and authorise the WebSocket upgrade.
   * Returns HTTP 400/401/403/404/422 to reject the upgrade before the
   * WebSocket connection is established.
   */
  const authPreHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const q = request.query as Record<string, string | undefined>;
    const { token, interviewId } = q;

    if (!interviewId) {
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: 'Missing interviewId query parameter' });
    }

    let userId: string;

    if (process.env.COGNITO_BYPASS === 'true') {
      userId = getBypassUser().userId;
    } else {
      if (!token) {
        return reply
          .code(401)
          .send({ code: 'UNAUTHORIZED', message: 'Missing token query parameter' });
      }
      try {
        const user = await verifyToken(token);
        userId = user.userId;
      } catch {
        return reply
          .code(401)
          .send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
    }

    // Verify interview ownership and status.
    let interview: { id: string; userId: string; status: string } | null = null;
    try {
      interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        select: { id: true, userId: true, status: true },
      });
    } catch {
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Database error' });
    }

    if (interview === null) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Interview not found' });
    }

    if (interview.userId !== userId) {
      return reply
        .code(403)
        .send({ code: 'FORBIDDEN', message: 'Interview does not belong to this user' });
    }

    if (interview.status !== 'in_progress') {
      return reply
        .code(422)
        .send({ code: 'INVALID_STATE', message: 'Interview is not in_progress' });
    }

    // Attach validated context for the WebSocket handler.
    request.sttContext = { userId, interviewId };
  };

  // Use (fastify as any) to avoid TypeScript conflicts between the base
  // FastifyInstance.get overload and the WebSocket-specific one added by
  // @fastify/websocket's type augmentation. At runtime this is a normal
  // Fastify route registration with websocket: true.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fastify as any).get(
    '/stt',
    { websocket: true, preHandler: authPreHandler },
    async (connection: SocketStream, request: FastifyRequest): Promise<void> => {
      // @fastify/websocket passes a SocketStream (Duplex). The raw WebSocket
      // lives at connection.socket — use that for send/readyState/events.
      const socket = connection.socket;
      const { interviewId } = request.sttContext!;

      // Acknowledge successful authentication.
      sendToClient(socket, { type: 'session_ready' });

      // Safety timeout: spec requires the backend to close the session after
      // 6 minutes (5-min frontend cap + 1-min margin).
      const sessionTimeout = setTimeout(() => {
        sendToClient(socket, {
          type: 'error',
          code: 'recording_too_long',
          message: 'Maximum recording duration exceeded',
        });
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1008, 'recording_too_long');
        }
      }, MAX_SESSION_MS);

      if (process.env.ELEVENLABS_MOCK === 'true') {
        handleMockSession(socket, interviewId, sessionTimeout);
      } else {
        await handleElevenLabsProxy(socket, interviewId, sessionTimeout);
      }
    },
  );
};

export default sttProxy;
