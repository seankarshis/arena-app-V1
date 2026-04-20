// ---------------------------------------------------------------------------
// Arena Interview Prompt Builder — M2a
//
// Pure function: buildPrompt(session, promptVersion) → BuiltPrompt
//
// Tier 1 (static, cacheable): Output Contract + 8 numbered sections from
// interviewer-prompt-v{N}.md. Loaded once at module initialisation, cached
// in memory keyed by promptVersion. The cacheBreakpoint character index marks
// the end of Tier 1 in the assembled system string — the Anthropic SDK places
// cache_control: { type: 'ephemeral' } at that boundary.
//
// Tier 2 (dynamic, per-call): Interview context, per-question guide rendered
// with status-aware verbosity, facts ledger, active threads, rapport notes.
// Template-specific systemPrompt override is appended after Tier 2 preamble.
//
// Messages array: last 8 turn pairs (16 messages) from session history, plus
// the current interviewee utterance as the final user message.
//
// No I/O inside buildPrompt — spec file reads happen via the cache populated
// at module load. No Anthropic SDK calls, no ClickHouse writes.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { CoverageStatus } from '../observability/events';
import type {
  AnthropicMessage,
  CoverageEntry,
  InterviewSessionState,
  SessionQuestion,
} from './sessionState';

// ---------------------------------------------------------------------------
// Re-exports — keep the historical public API stable for existing importers.
// The canonical definitions now live in ./sessionState.ts.
// ---------------------------------------------------------------------------

export type {
  AnthropicMessage,
  ActiveThread,
  CoverageEntry,
  FactsLedgerEntry,
  InterviewSessionState,
  SessionQuestion,
} from './sessionState';

/** The assembled prompt ready for the Anthropic SDK. */
export interface BuiltPrompt {
  /** Full assembled system string: Tier 1 + Tier 2 + optional template override. */
  system: string;
  /** Conversation turns: last 8 pairs + current utterance. No system role. */
  messages: AnthropicMessage[];
  /**
   * Character index in `system` where Tier 1 ends.
   * The Anthropic SDK places cache_control: { type: 'ephemeral' } at this boundary.
   */
  cacheBreakpoint: number;
}

// ---------------------------------------------------------------------------
// Module-scope Tier 1 cache
// Keyed by promptVersion string. Populated on first call per version.
// ---------------------------------------------------------------------------

interface Tier1Cache {
  content: string;
}

const tier1Cache = new Map<string, Tier1Cache>();

/**
 * Returns the number of distinct prompt versions currently held in the
 * module-scope Tier 1 cache. Exposed for test verification only.
 * @internal
 */
export function _tier1CacheSize(): number {
  return tier1Cache.size;
}

/**
 * Clears the Tier 1 cache. Exposed for test isolation only.
 * @internal
 */
export function _clearTier1Cache(): void {
  tier1Cache.clear();
}

// ---------------------------------------------------------------------------
// Version → spec file path mapping
// Fail loudly on unknown versions per ADR 013.
// ---------------------------------------------------------------------------

const SPEC_VERSION_MAP: Record<string, string> = {
  v1: path.resolve(__dirname, '../../../brain/specs/interviewer-prompt-v1.md'),
  v2: path.resolve(__dirname, '../../../brain/specs/interviewer-prompt-v2.md'),
};

function resolveSpecPath(promptVersion: string): string {
  const specPath = SPEC_VERSION_MAP[promptVersion];
  if (!specPath) {
    throw new Error(
      `[buildPrompt] Unknown promptVersion: "${promptVersion}". ` +
      `Known versions: ${Object.keys(SPEC_VERSION_MAP).join(', ')}. ` +
      `To add a new version, create brain/specs/interviewer-prompt-v{N}.md and add an entry to SPEC_VERSION_MAP.`,
    );
  }
  return specPath;
}

// ---------------------------------------------------------------------------
// Tier 1 parser
//
// Parses brain/specs/interviewer-prompt-v{N}.md and extracts:
// 1. The "## Output Contract" section body (before Tier 1 sections).
// 2. The eight numbered subsections under "## Tier 1 — Static Prompt Sections".
//
// Section headings (### N. Name) are stripped; body text is concatenated with
// blank-line separators. The output contract precedes the Tier 1 sections.
// ---------------------------------------------------------------------------

function parseTier1(specPath: string): string {
  const raw = fs.readFileSync(specPath, 'utf-8');

  // --- Extract Output Contract section ---
  const outputContractMatch = raw.match(
    /^## Output Contract\s*\n([\s\S]*?)(?=\n^## |\n^---)/m,
  );
  if (!outputContractMatch) {
    throw new Error(
      `[buildPrompt] Could not find "## Output Contract" section in spec: ${specPath}`,
    );
  }
  const outputContractBody = outputContractMatch[1].trimEnd();

  // --- Extract Tier 1 sections block ---
  const tier1BlockMatch = raw.match(
    /^## Tier 1 — Static Prompt Sections\s*\n([\s\S]*?)(?=\n^## |\n^---)/m,
  );
  if (!tier1BlockMatch) {
    throw new Error(
      `[buildPrompt] Could not find "## Tier 1 — Static Prompt Sections" in spec: ${specPath}`,
    );
  }
  const tier1Block = tier1BlockMatch[1];

  // Split the block on numbered headings: ### N. Name
  // This gives us chunks; the first chunk is the intro paragraph (e.g. "The sections below..."),
  // and subsequent chunks are the section bodies.
  const sectionSplitRegex = /^### \d+\. .+$/m;
  const chunks = tier1Block.split(sectionSplitRegex);

  // chunks[0] is the intro text before "### 1. Persona" — we discard it.
  // chunks[1..] are the eight section bodies.
  const sectionBodies = chunks.slice(1).map((s) => s.trim()).filter((s) => s.length > 0);

  if (sectionBodies.length !== 8) {
    throw new Error(
      `[buildPrompt] Expected 8 Tier 1 sections in spec, found ${sectionBodies.length}: ${specPath}`,
    );
  }

  // Join: Output Contract + blank line + each section body separated by blank lines.
  const parts: string[] = [outputContractBody, ...sectionBodies];
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tier 1 loader with module-scope cache
// ---------------------------------------------------------------------------

function loadTier1(promptVersion: string): string {
  const cached = tier1Cache.get(promptVersion);
  if (cached) {
    return cached.content;
  }

  const specPath = resolveSpecPath(promptVersion);
  const content = parseTier1(specPath);
  tier1Cache.set(promptVersion, { content });
  return content;
}

// ---------------------------------------------------------------------------
// Tier 2 assembly helpers
// ---------------------------------------------------------------------------

/** Render a question in full briefing format (not_started / partially_covered). */
function renderQuestionFull(
  q: SessionQuestion,
  entry: CoverageEntry | undefined,
  index: number,
): string {
  const lines: string[] = [];
  const label = q.isRequired ? 'required' : 'optional';
  const sensitivity = q.sensitivityLevel.replace(/_/g, ' ');
  const tagList = q.tags.length > 0 ? q.tags.join(', ') : 'none';
  const currentStatus = entry?.status ?? 'not_started';
  const currentConfidence = entry?.confidence ?? null;
  const currentSummary = entry?.summary ?? null;

  lines.push(`### Q${index + 1} — ${q.categoryBucket} (${label})`);
  lines.push(`Tags: ${tagList}`);
  lines.push(`Sensitivity: ${sensitivity}`);
  lines.push(`Question text: ${q.questionText}`);

  if (q.intent !== null) {
    lines.push(`Briefing: ${q.intent}`);
  } else {
    lines.push(`Briefing: (No briefing provided; infer intent from question text and tags.)`);
  }

  if (q.adminNotes) {
    lines.push(`Admin notes: ${q.adminNotes}`);
  }

  lines.push(`Current status: ${currentStatus}` + (currentConfidence ? ` (confidence: ${currentConfidence})` : ''));

  if (currentSummary) {
    lines.push(`Summary so far: ${currentSummary}`);
  }

  return lines.join('\n');
}

/** Render a question in compact one-line format (fully_covered / skipped). */
function renderQuestionCompact(
  q: SessionQuestion,
  entry: CoverageEntry,
  index: number,
): string {
  if (entry.status === 'skipped') {
    const reason = entry.summary ? entry.summary : 'no reason recorded';
    return `Q${index + 1} (${q.categoryBucket}) — skipped: ${reason}`;
  }
  // fully_covered
  const confidence = entry.confidence ?? 'unknown';
  const summary = entry.summary ?? '(no summary)';
  return `Q${index + 1} (${q.categoryBucket}) — ${entry.status} (${confidence}): ${summary}`;
}

/** Assemble the Tier 2 dynamic section as a string. */
function assembleTier2(session: InterviewSessionState): string {
  const parts: string[] = [];

  parts.push('---');
  parts.push('## Interview Context');
  parts.push(
    `Interviewee: ${session.intervieweeName}, ${session.intervieweeRole} at ${session.intervieweeCompany}`,
  );
  parts.push(`Template focus: ${session.templateFocus}`);

  parts.push('');
  parts.push('## Interview Guide');

  // Sort questions by sequenceOrder for stable rendering.
  const sorted = [...session.questions].sort(
    (a, b) => a.sequenceOrder - b.sequenceOrder,
  );

  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i];
    const entry = session.coverage[q.questionId];
    const status: CoverageStatus = entry?.status ?? 'not_started';

    if (status === 'not_started' || status === 'partially_covered') {
      parts.push('');
      parts.push(renderQuestionFull(q, entry, i));
    } else {
      // fully_covered or skipped — one-line compact
      if (!entry) {
        // Should not happen, but be defensive
        parts.push(`Q${i + 1} (${q.categoryBucket}) — not_started`);
      } else {
        parts.push(renderQuestionCompact(q, entry, i));
      }
    }
  }

  parts.push('');
  parts.push('## Facts Ledger');
  if (session.factsLedger.length === 0) {
    parts.push('(empty — facts are populated asynchronously by the enrichment sidecar)');
  } else {
    for (const entry of session.factsLedger) {
      parts.push(`- ${entry.text} (turn ${entry.sourceTurn})`);
    }
  }

  parts.push('');
  parts.push('## Active Threads');
  if (session.activeThreads.length === 0) {
    parts.push('(none)');
  } else {
    for (const thread of session.activeThreads) {
      parts.push(`- ${thread.topic} (opened turn ${thread.openedAtTurn})`);
    }
  }

  parts.push('');
  parts.push('## Rapport Notes');
  if (session.rapportNotes.length === 0) {
    parts.push('(none)');
  } else {
    for (const note of session.rapportNotes) {
      parts.push(`- ${note}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Messages assembly
// ---------------------------------------------------------------------------

const MAX_TURN_PAIRS = 8; // last 8 turn pairs = 16 messages
const MAX_HISTORY_MESSAGES = MAX_TURN_PAIRS * 2;

/**
 * Build the messages array: last 8 turn pairs from history + current utterance.
 * Trims the history to the most recent MAX_HISTORY_MESSAGES messages.
 * Ensures the array starts with role: 'user' (Anthropic API requirement) by
 * dropping leading assistant messages if the window truncated mid-pair.
 */
function buildMessages(session: InterviewSessionState): AnthropicMessage[] {
  // Trim to last MAX_HISTORY_MESSAGES entries
  const history = session.conversationHistory.slice(-MAX_HISTORY_MESSAGES);

  // If truncation left a leading assistant message, drop it
  let trimmedHistory = history;
  if (trimmedHistory.length > 0 && trimmedHistory[0].role === 'assistant') {
    trimmedHistory = trimmedHistory.slice(1);
  }

  // Append the current user utterance
  const currentMessage: AnthropicMessage = {
    role: 'user',
    content: session.currentUserUtterance,
  };

  return [...trimmedHistory, currentMessage];
}

// ---------------------------------------------------------------------------
// Public API: buildPrompt
// ---------------------------------------------------------------------------

/**
 * Pure function: assembles the full prompt for one interview turn.
 *
 * @param session  - Full session state including conversation history.
 * @param promptVersion - Version string, e.g. 'v1'. Must match a known version.
 * @returns BuiltPrompt with system string, messages array, and cacheBreakpoint.
 */
export function buildPrompt(
  session: InterviewSessionState,
  promptVersion: string,
): BuiltPrompt {
  // --- Tier 1: load from cache (or parse spec on first call) ---
  const tier1 = loadTier1(promptVersion);
  const cacheBreakpoint = tier1.length;

  // --- Tier 2: assemble from session state ---
  const tier2 = assembleTier2(session);

  // --- Template-specific override (after Tier 2 guide, before messages) ---
  let system = tier1 + '\n\n' + tier2;
  if (session.templateSystemPromptOverride) {
    system += '\n\n---\n## Template-Specific Framing\n\n' + session.templateSystemPromptOverride;
  }

  // --- Messages ---
  const messages = buildMessages(session);

  return { system, messages, cacheBreakpoint };
}
