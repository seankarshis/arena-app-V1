import { getRedisClient } from './redis';

// --- TTL Constants (seconds) ---

/** Active interview sessions expire after 4 hours of no state-mutating activity. */
export const ACTIVE_SESSION_TTL = 4 * 60 * 60; // 14400s

/** Paused interview sessions are kept warm for 15 minutes before Redis evicts them. */
export const PAUSED_SESSION_TTL = 15 * 60; // 900s

// --- Key helpers ---

function sessionKey(interviewId: string): string {
  return `interview:session:${interviewId}`;
}

// --- Types ---

export interface ConversationEntry {
  role: 'assistant' | 'user';
  content: string;
  /** Present on assistant messages that deliver a question. */
  questionId?: string;
  /** 1-based question counter; present on assistant question messages. */
  sequenceNumber?: number;
  /** Present on user messages to indicate input method. */
  inputMode?: 'voice' | 'text';
  /** Marker for special assistant messages (e.g. idle prompts). */
  type?: string;
}

export interface TriggeredFollowup {
  triggeredBy: string;
  suggested: string[];
}

export interface DraftEntry {
  content: string;
  inputMode: 'voice' | 'text';
  sttConfidenceScore?: number;
  createdAt: string;
}

export interface InterviewSession {
  interviewId: string;
  templateId: string;
  userId: string;

  conversationHistory: ConversationEntry[];

  questionsAsked: string[];
  questionsSkipped: string[];
  bucketsCovered: Record<string, number>;

  requiredRemaining: string[];
  optionalRemaining: string[];

  triggeredFollowups: TriggeredFollowup[];

  currentTranscriptBuffer: string;
  currentDrafts: DraftEntry[];

  totalExpectedQuestions: number;
  questionsCompleted: number;

  lastActivityAt: string;
  idleWarningShown: boolean;

  /** Atomic turn lock — true while the LLM is streaming a response. */
  isStreaming: boolean;
  /** Accumulates the LLM's streamed output for the current turn. null when no turn is active. */
  currentTurnLlmText: string | null;
}

// --- Session operations ---

export async function createSession(
  session: InterviewSession,
): Promise<void> {
  const redis = getRedisClient();
  const key = sessionKey(session.interviewId);
  await redis.set(key, JSON.stringify(session), 'EX', ACTIVE_SESSION_TTL);
}

export async function getSession(
  interviewId: string,
): Promise<InterviewSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(sessionKey(interviewId));
  if (!raw) return null;
  return JSON.parse(raw) as InterviewSession;
}

export async function updateSession(
  interviewId: string,
  patch: Partial<InterviewSession>,
): Promise<InterviewSession | null> {
  const redis = getRedisClient();
  const key = sessionKey(interviewId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const session: InterviewSession = { ...JSON.parse(raw), ...patch };
  await redis.set(key, JSON.stringify(session), 'EX', ACTIVE_SESSION_TTL);
  return session;
}

export async function deleteSession(interviewId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(sessionKey(interviewId));
}

export async function refreshSessionTTL(
  interviewId: string,
  ttl: number = ACTIVE_SESSION_TTL,
): Promise<boolean> {
  const redis = getRedisClient();
  const result = await redis.expire(sessionKey(interviewId), ttl);
  return result === 1;
}

export async function setSessionPausedTTL(
  interviewId: string,
): Promise<boolean> {
  return refreshSessionTTL(interviewId, PAUSED_SESSION_TTL);
}

// --- Helpers for building initial session state ---

export function buildInitialSession(params: {
  interviewId: string;
  templateId: string;
  userId: string;
  requiredQuestionIds: string[];
  optionalQuestionIds: string[];
  totalExpectedQuestions: number;
  bucketNames: string[];
}): InterviewSession {
  const bucketsCovered: Record<string, number> = {};
  for (const bucket of params.bucketNames) {
    bucketsCovered[bucket] = 0;
  }

  return {
    interviewId: params.interviewId,
    templateId: params.templateId,
    userId: params.userId,
    conversationHistory: [],
    questionsAsked: [],
    questionsSkipped: [],
    bucketsCovered,
    requiredRemaining: params.requiredQuestionIds,
    optionalRemaining: params.optionalQuestionIds,
    triggeredFollowups: [],
    currentTranscriptBuffer: '',
    currentDrafts: [],
    totalExpectedQuestions: params.totalExpectedQuestions,
    questionsCompleted: 0,
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
    isStreaming: false,
    currentTurnLlmText: null,
  };
}
