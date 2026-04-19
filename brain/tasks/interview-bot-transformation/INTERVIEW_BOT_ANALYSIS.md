# Interview Bot Transformation — Phase 1 Discovery Analysis

**Author:** Claude (Phase 1 Discovery, autonomous)
**Date:** 2026-04-18
**Status:** Draft pending approval
**Deliverable gate:** Phase 2 Design is blocked on approval of this document
**New ClickHouse event types proposed below are blocked on explicit approval per `02-OPERATIONAL-GUARDRAILS.md`**

---

## 0. Orientation

The current interview engine is not a naive question queue — it is a **hybrid deterministic-queue + LLM-guidance** system with sophisticated snapshot and turn-lock plumbing already in place. Discovery therefore has two flavours:

- **Preserve** the real craftsmanship already in the code (snapshot mechanism, atomic turn lock, fire-and-forget ClickHouse writes, SSE sentence-boundary streaming, session TTL model).
- **Replace** the orchestration nucleus: the LLM today is *advised* about triggers and remaining questions but its output is never parsed; the system deterministically picks `requiredRemaining[0]` every turn. That produces queue-feeling conversations even though the prompt asks for judgment.

Everything below follows from that framing. Section 7 (what must change) and Section 8 (proposed approach) are the operative ones; the earlier sections exist to anchor those proposals in the current system.

---

## 1. Current Architecture

### 1.1 Module map

| Concern | File(s) | Role |
|---|---|---|
| Interview orchestration service | `api/src/services/interviewEngine.ts` | `submitResponse`, `skipQuestion`, `completeInterview`; calls Claude non-streaming, persists to Postgres + Redis |
| Session start/pause/resume | `api/src/services/interviewSession.ts` | `startInterview`, `pauseInterview`, `resumeInterview`; emits `interview_lifecycle` telemetry |
| Redis session shape & helpers | `api/src/services/session.ts` (via `sessionStore`) | `createSession`, `getSession`, `updateSession`, `refreshSessionTTL`, `deleteSession` |
| System prompt builder | `api/src/services/promptConstructor.ts` | Assembles static instructions + required/optional questions + per-question trigger lines |
| Turn context builder | `api/src/services/stateManager.ts` | `buildTurnContext`, `formatTurnContext`, `applyQuestionAsked`, `applyFollowupTriggered`, `getNextQuestion` |
| SSE streaming | `api/src/sse/stream.ts` | Token + sentence_complete + stream_complete events; sentence-boundary chunking for TTS; first-question trigger; reconnect replay |
| GraphQL resolvers | `api/src/schema/resolvers.ts` | Thin orchestration service adapters; `pushTurnToSSE` fire-and-forget after submit/skip |
| Inactivity / auto-pause | `api/src/services/inactivityHandler.ts` | 60s idle-prompt, 3min auto-pause, heartbeat receive |
| Observability | `api/src/observability/{clickhouseWriter,sanitize,validateConfig,types}.ts` | Single `arena_telemetry` table, automatic sanitization, OTEL trace correlation |
| Cleaning Lambda | `api/src/lambda/cleaning-handler.ts` | Async transcription cleaning via Claude; fires on `interview.completed` EventBridge event |
| Reconciliation Lambda | `api/src/lambda/reconciliation-handler.ts` | 15-minute cron sweep: stuck cleanings, stale turn locks, abandoned interviews |
| Admin UI — questions | `frontend/src/app/admin/questions/page.tsx` + `components/admin/QuestionBank.tsx` | CRUD, pill tag multi-select, category dropdown |
| Admin UI — templates | `frontend/src/app/admin/templates/[id]/page.tsx` + `components/admin/TemplateBuilder.tsx` | Compose template, drag reorder, category bucket, required flag, per-question trigger editor |
| Admin UI — trigger editor | `frontend/src/components/admin/TriggerEditor.tsx` | `keyword | sentiment | length | always` with `targetTemplateQuestionIds` multi-select |
| Admin UI — tags | `frontend/src/app/admin/tags/page.tsx` + `TagManager` | CRUD; flat list; soft-delete toggle |

### 1.2 Data flow, one turn

```
Frontend (REVIEW → PROCESSING)
   │
   │  GraphQL:  submitResponse(interviewId, rawTranscription, inputMode)
   ▼
resolvers.submitResponse
   │
   ▼
interviewEngine.submitResponse
   │   ┌── DB read: Interview, Template, TemplateQuestions (with Question, Tags)
   │   ├── Redis read: InterviewSession
   │   ├── DB write (transaction): InterviewResponse row
   │   ├── Redis write: isStreaming=true + append user turn to conversationHistory
   │   ├── Claude call (non-streaming): buildSystemPrompt + formatTurnContext
   │   ├── Redis write: isStreaming=false, currentTurnLlmText=fullResponse,
   │   │                append assistant turn, advance question pools
   │   └── DB write: response cost metrics + interview totals (same transaction)
   │
   ▼  (fire-and-forget)
sse/stream.pushTurnToSSE
   │   ├── Read session.currentTurnLlmText
   │   ├── Detect sentence boundaries offline
   │   ├── Emit token events (synthetic, chunked from cached text)
   │   ├── Emit sentence_complete events (→ frontend TTS)
   │   └── Emit stream_complete { fullResponse, questionId, interviewComplete, progressPercent }
   │
   ▼
ClickHouse: llm_turns event (interviewId, questionId, tokens, latencyMs, model)
```

### 1.3 Where the orchestration decision actually lives

This is the single most important finding for Phase 2. Two places share the decision, neither of them is the LLM:

- `interviewEngine.submitResponse` line 411 — `getNextQuestion(sessionAfterResponse)` which is literally `requiredRemaining[0] ?? optionalRemaining[0] ?? null` in `stateManager.ts`.
- `promptConstructor.buildSystemPrompt` — passes **all remaining required + optional questions every turn** with trigger lines like `"- If mentions data quality → suggest follow-up {uuid}"`.

The LLM is told about triggers and asked to honor them "in its judgment," but its output is never parsed for orchestration signals. It produces prose, the system picks the next question deterministically from the head of the queue, and the LLM's voice is asked to make that feel natural. When the LLM's natural next question diverges from `requiredRemaining[0]` the two drift silently apart.

This is the seam where the transformation lives.

---

## 2. Current Data Model

### 2.1 Postgres (via Prisma) — actual implemented schema

Annotated from `api/prisma/schema.prisma` (line references are to the current file).

**`Tag`** (lines 10–22)
- `id` uuid, `label` unique varchar(255), `isActive` bool, timestamps.
- **Flat. No `tagType` column.** Junctions: `question_tags`, `user_tags`.
- ⚠️ **Conflict with `interview-spec-v2.md` Section 4** which specifies a `tag_type` enum (`role | department | topic | seniority | domain`). Current code omits it. See §10.

**`Question`** (lines 24–39)
- `id` uuid, `text` text, `category` varchar(100), `isActive` bool, timestamps.
- No `intent`, no `sensitivityLevel`. Both must be added in Phase 2.

**`InterviewTemplate`** (lines 118–134)
- `id`, `name`, `description?`, **`systemPrompt? text`** (already present — custom per-template override), `status` varchar (`draft` / `published`), timestamps.
- The `systemPrompt` column is the natural integration point for the new versioned prompt artifact (see §8.5).

**`TemplateQuestion`** (lines 136–152) — junction w/ metadata
- `templateId`, `questionId`, `sequenceOrder` (unique per template), `categoryBucket`, `isRequired` (default true), `followupTriggers` JSONB array, timestamps.
- Trigger shape currently in production:
  ```json
  { "type": "keyword" | "sentiment" | "length" | "always",
    "keywords": "comma,separated", "sentiment": "positive|negative|neutral",
    "lengthDescription": "free text", "targetTemplateQuestionIds": ["tq-uuid", ...] }
  ```
  Note: targets are `TemplateQuestion.id`, not `Question.id`. `sse/stream.ts` maintains a `tqIdToQuestionId` map to resolve them when building the prompt.

**`UserTemplate`** (lines 81–99)
- Many-to-many user ↔ template with `status` (`active` / `completed` / `removed`), `assignedAt`, `assignedBy`, `completedAt?`, `removedAt?`.
- **Authoritative per CLAUDE.md** — v3's call to replace this with `users.current_template_id` is explicitly ignored. No action needed.

**`Interview`** (lines 154–177)
- `id`, `userId`, `templateId`, `status` (`scheduled | in_progress | paused | completed | abandoned`), `sessionSnapshot` JSONB (Redis → DB freeze on pause), timestamps (`startedAt`, `pausedAt`, `completedAt`), rolling cost totals (`totalLlmPromptTokens`, `totalLlmCompletionTokens`, `totalSttDurationSeconds`, `totalTtsCharacters`).

**`InterviewResponse`** (lines 179–221)
- The snapshot record. Critical fields for this work:
  - `questionTextAsAsked` — the LLM's actual delivered phrasing, sourced from Redis `currentTurnLlmText` at submit time. **Spec Section 19 rule #2 — "Snapshots are the source of truth for historical data"** depends on this field. Unchanged in transformation.
  - `tagsAtTime` JSONB — snapshot of question tags.
  - `categoryBucket?` — snapshot of template bucket.
  - `isFollowup`, `parentResponseId?` — follow-up lineage.
  - `sequenceNumber` — turn counter within interview.
  - Audio metadata (`s3AudioKey`, `audioDurationSeconds`, `audioUploadStatus`, ...) — preserved, ignored for text-only work.
  - Cleaning fields (`cleanedMarkdown`, `cleaningModel`, `cleanedAt`, `processingStatus`, `errorMessage`).
  - Cost fields (`llmPromptTokens`, `llmCompletionTokens`, `llmModel`, `llmLatencyMs`, `sttDurationBilledSeconds`, `ttsCharactersBilled`).
- **Per-turn cost capture is a spec invariant** (Section 19 rule #21). Transformation must preserve.

**`ResponseDraft`** (lines 223–244) — multi-take redo drafts, admin-visible only.

**`UserConsentRecord`** (lines 246–260) — `data_processing | audio_recording | ai_interaction` × version, granted/revoked timestamps, IP.

**`AdminAuditLog`** (lines 262–276) — append-only, written by Prisma middleware on every admin mutation (spec Section 19 rule #20).

### 2.2 Redis — `interview:session:{interviewId}`

From `api/src/services/session.ts`. TTL: 4h active (`ACTIVE_SESSION_TTL`), 15min paused (`PAUSED_SESSION_TTL`). Reconstructable from `interview_responses` + `Interview.sessionSnapshot` per spec Section 19 rule #10.

```typescript
interface InterviewSession {
  interviewId: string;
  templateId: string;
  userId: string;

  conversationHistory: ConversationEntry[];    // role | content | questionId? | sequenceNumber? | inputMode? | type?('idle_prompt')
  questionsAsked: string[];                    // Question IDs delivered
  questionsSkipped: string[];
  bucketsCovered: Record<string, number>;      // categoryBucket → count
  requiredRemaining: string[];                 // TemplateQuestion IDs still outstanding
  optionalRemaining: string[];
  triggeredFollowups: TriggeredFollowup[];     // analytics only — never consumed

  currentTranscriptBuffer: string;             // live STT partial during RECORDING
  currentDrafts: DraftEntry[];
  totalExpectedQuestions: number;
  questionsCompleted: number;
  lastActivityAt: string;
  idleWarningShown: boolean;

  // ATOMIC TURN LOCK (spec Section 19 rule #22)
  isStreaming: boolean;
  currentTurnLlmText: string | null;           // becomes questionTextAsAsked on next submit
}
```

### 2.3 ClickHouse — `arena_telemetry`

Single table. Columns: `install_id, timestamp, environment, service_name, event_type, severity, trace_id, span_id, attributes(JSON string)`. All writes go through `clickHouseWrite()` which automatically pseudonymizes PII-adjacent keys via HMAC-SHA256 and redacts known PII keys (`email`, `phone`, `transcript`, `questiontext`, `content`, ...).

Already-registered event types emitted on the interview path (per `.claude/agents/observability-enforcer.md`):
- `interview_lifecycle` — sub-events: `started`, `paused`, `resumed`, `auto_paused`, `abandoned`, `completed`.
- `llm_turns` — every streamed response (tokens, latency, model).
- `stt_session` — `opened` / `closed`.
- `cleaning_metrics` / `cleaning_summary` — async cleaning lambda.
- `reconciliation_run` — 15-min cron sweeps.

---

## 3. Current Conversation Flow (End-to-End)

Step-by-step from `startInterview` to `completeInterview`:

1. **Start.** Frontend calls `startInterview(templateId)`. Resolver → `interviewSession.startInterview`:
   - Cognito JWT `sub` → `userId`. Validates active `UserTemplate` + consent. Rejects if user has any other `in_progress` interview (one-at-a-time invariant, spec Section 19 rule #19).
   - Creates `Interview` row with status `in_progress`, `startedAt=now()`.
   - Fetches `TemplateQuestion`s ordered by `sequenceOrder`, partitions into required/optional, seeds Redis session with empty conversation, all pools populated, counters zeroed, `isStreaming=false`, `currentTurnLlmText=null`.
   - Emits `interview_lifecycle { event: 'started' }`.
   - Returns `{ interviewId, totalQuestions }`. **The first question is NOT in the mutation response.**
2. **SSE handshake.** Frontend opens `GET /api/interview/:id/stream`. Server validates ownership, registers the connection, and (if `conversationHistory.length === 0`) calls `triggerFirstQuestion`:
   - Sets `isStreaming=true`.
   - Builds full system prompt from template + all remaining triggers.
   - Calls streaming Claude with user content `"Please begin the interview."`.
   - Emits `token` events, then on sentence boundary emits `sentence_complete` (frontend starts TTS for that sentence).
   - On completion: persists LLM text as `currentTurnLlmText`, appends assistant entry to history, advances `questionsAsked` / removes from `requiredRemaining` or `optionalRemaining`, clears lock, emits `stream_complete { questionId, interviewComplete:false, progressPercent }`, writes `llm_turns`.
3. **User records / types.** Frontend goes RECORDING → REVIEW → PROCESSING. Submits via `submitResponse(interviewId, rawTranscription, inputMode)`.
4. **`interviewEngine.submitResponse`:**
   - Auth + ownership check.
   - Reads session; rejects if `isStreaming=true` with `INVALID_STATE / TURN_IN_PROGRESS`.
   - **Resolves `currentQuestion`** from last assistant entry in `conversationHistory`. `questionTextAsAsked` comes from `currentTurnLlmText`.
   - Writes `InterviewResponse` row inside a transaction alongside cost metric updates.
   - Acquires turn lock, appends user turn, calls Claude non-streaming (yes — the submit path uses the non-streaming client while SSE's `triggerFirstQuestion` uses streaming; `pushTurnToSSE` then synthetically re-chunks the cached text back out to the SSE connection).
   - On LLM response: stores `currentTurnLlmText`, advances pools, clears lock, emits fire-and-forget `pushTurnToSSE`.
5. **`pushTurnToSSE`:** reads the cached full text, chunks it into sentence events so TTS still streams progressively, emits `stream_complete`. **If the LLM judged the interview complete** (in current code, this is inferred by `requiredRemaining.length === 0 && optionalRemaining.length === 0`), `interviewComplete=true`.
6. **Frontend branches:** `COMPLETING → UPLOADING → COMPLETED` if interview complete; `AWAITING_INPUT` otherwise.
7. **Pause / Resume.** `pauseInterview` snapshots Redis to `Interview.sessionSnapshot` JSONB, drops Redis TTL to 15 min, marks `pausedAt`. `resumeInterview` reconstructs session from snapshot if Redis is cold, clears `pausedAt`.
8. **Complete.** `completeInterview` sets `status='completed'`, freezes final snapshot, flushes Redis, publishes EventBridge `interview.completed` (triggers cleaning lambda), emits `interview_lifecycle { event: 'completed' }`.
9. **Cleaning (async, post-completion):** Lambda pulls SQS message, iterates responses with `processingStatus='pending'`, calls Claude with a cleaning prompt, writes `cleanedMarkdown` + cost, emits `cleaning_metrics` per response and `cleaning_summary` for the batch.

---

## 4. Current System Prompt Construction

From `api/src/services/promptConstructor.ts` (167 lines) and `stateManager.ts`.

### 4.1 Static base

Only one cacheable-looking block, and it's conditional on the template having no `systemPrompt` override:

```
You are conducting a structured research interview.
## Interview Context
Template: {name}
Description: {description?}
```

If the template has a `systemPrompt`, that override replaces the base entirely. There is no persona, no tone guidance, no response-handling patterns, no opening/closing ritual, no leading-question avoidance — none of the consultant-voice scaffolding.

### 4.2 Dynamic question bank (rebuilt every turn)

```
## Required Questions
You MUST ask all of the following questions during this interview.

### Category: {bucket}
{questionId} (required): "{text}"
  Suggested sequence: {n}
  Follow-up triggers:
    - {condition} → suggest follow-up {followupQuestionId}
    - ...

## Optional Questions
(same structure)
```

The full bank is emitted in both required and optional lists every turn, even after most questions are covered. There is no tiering, no compression of completed questions, no "active vs outstanding" distinction.

### 4.3 Instructions section

```
- After each answer, evaluate the follow-up triggers for that question based on your judgment.
  If trigger conditions are met, ask one of the suggested follow-ups before moving to the next core question.
- Move between different category buckets to maintain conversational variety.
- Do not ask questions that substantially overlap with questions already asked.
- If a trigger references a follow-up question that is not in your current question set, skip that trigger.
```

### 4.4 Turn context (appended after the user's transcription)

From `stateManager.formatTurnContext`:

```
{rawTranscription}

---

### Coverage so far
- Asked: {count}
- Skipped: {count}
- Required remaining: {count}
- Optional remaining: {count}
- Buckets covered (counts): {json}

### Follow-Up Triggers for Current Question
Evaluate these against the user's response:
- {trigger.condition} → suggest follow-up {followupQuestionId}
```

### 4.5 What's missing vs. design principles

Measured against `01-DESIGN-PRINCIPLES.md` §"System Prompt Architecture":

| Required | Present today? |
|---|---|
| Consultant persona (McKinsey-style voice, tone examples) | **No** |
| Assess-Evaluate-Decide-Act reasoning loop | **No** |
| Response handling patterns (vague, unknown, defensive, tangent, out-of-scope) | **No** |
| Opening / closing rituals | **No** |
| Leading-question avoidance | **No** |
| Interview guide format (intent + status per topic) | **No** — only `(required): "text"` |
| Coverage map with status + confidence | **Partial** — only counts, no per-question status |
| Compressed completed-question summaries | **No** — completed questions leave the prompt entirely |
| Facts ledger, active threads, rapport notes | **No** |
| Structured output block | **No** |
| Prompt caching order (static first, dynamic second) | **No** — static and dynamic are interleaved |

---

## 5. Current Admin Interface

From `frontend/src/app/admin/**` and `frontend/src/components/admin/**`.

### 5.1 What works
- **Pill-based tag multi-select with autocomplete** already matches the Phase 2 design.
- **Drag-to-reorder** on template question list. Clean and direct.
- **TriggerEditor** is a sophisticated per-question modal with multi-select of follow-up targets, auto-save debouncing, and type-specific conditional fields.
- **Soft-delete toggles** are wired for Tag, Question, and Template per spec Section 19 rule #6.
- **Published-template guardrails** — warnings when deactivating a tag or question referenced by a published template.
- **Assignment blocking** — removing a `UserTemplate` while an `in_progress` / `paused` interview exists for that template is blocked.

### 5.2 What's clunky
- **Tag assignment UX is fine; tag semantics are not.** Current tags carry no type, no intent, no governance beyond "admin can create it." The normalization + review queue design will live over the top of this.
- **Category is a per-question string field** (`Question.category`) AND a per-template override (`TemplateQuestion.categoryBucket`). This two-field split is poorly explained in the UI — admins see both and don't know which matters. In the new model, category as a structural concept is subsumed by `intent` + free-form tags on the question, and `categoryBucket` becomes optional template-side grouping (or goes away).
- **Trigger editor works for the current model, but the current model is wrong.** In Phase 2 we shift triggers from "structured if/then" to "soft guidance folded into `intent`." The trigger editor becomes either (a) a read-only legacy view for migration, or (b) a lighter "admin notes for the AI interviewer" field on the template-question junction. This is a migration question, not a UX question.
- **No coverage review surface.** After an interview completes, admins can view responses but there is no visualization of which questions were fully covered vs. partially vs. skipped, no confidence readout, no flagged-items list.
- **No flagged items dashboard.** Nothing exists.
- **No tag normalization queue.** Nothing exists.
- **No "interview guidance" section** on questions (no `intent` field, no `sensitivity_level`).

### 5.3 General UI review (deferred to Phase 2)

The admin users are non-technical PMs. The current admin UI leans engineering: IDs show through in places, error states are terse, breadcrumbs are inconsistent across `admin/questions`, `admin/templates`, `admin/tags`. Phase 2 will propose a holistic navigation pass in one ADR rather than scattered improvements.

---

## 6. What to Preserve (Do Not Break)

Grouped by criticality.

**Cannot change without breaking the spec or production data integrity:**
1. `question_text_as_asked` snapshot — the source of truth for what was asked (spec Section 19 rule #2).
2. `current_turn_llm_text` Redis caching pattern — feeds the snapshot on next submit; also enables SSE reconnect replay.
3. Atomic turn lock (`isStreaming`) including the reconciliation Lambda's 60s stale-lock reset (spec Section 19 rule #22, Section 12 Scan 1).
4. Backend-derived metadata rule — frontend never sends `questionId`, `questionTextAsAsked`, `sequenceNumber`, `tagsAtTime`, or `categoryBucket` (spec Section 19 rule #16).
5. Single-Postgres-transaction writes for response + cost metrics (spec Section 19 rule #1).
6. Soft-delete policy for Tag / Question / Template (spec Section 19 rule #6).
7. Consent gating in `startInterview` (spec Section 19 rule #17).
8. One-active-interview-per-user invariant (spec Section 19 rule #19).
9. Audit-log middleware on every admin mutation (spec Section 19 rule #20).
10. Per-turn cost capture (spec Section 19 rule #21).

**Should preserve (working well, no reason to change):**
11. Fire-and-forget ClickHouse write pattern via `clickHouseWrite()` — do not invent a new mechanism, do not block caller.
12. PII sanitization via `sanitizeForLog` — keyed on field names, applied automatically.
13. SSE sentence-boundary chunking for TTS. The abbreviation-aware regex and the 500-char clause-boundary fallback are carefully tuned.
14. Redis session reconstruction from `Interview.sessionSnapshot` + `InterviewResponse` history (ephemeral Redis, DB source of truth — spec Section 19 rule #10).
15. Prisma-only DB access; no raw SQL unless the builder can't express it (spec Section 19 rule #7).
16. Cognito JWT as sole auth (spec Section 19 rule #8).
17. Audio binary via presigned S3 URLs only — not GraphQL (spec Section 19 rule #4). (Audio work is out of scope for this transformation, but nothing we add should weaken this.)
18. Streaming LLM during `triggerFirstQuestion` — vs non-streaming in `submitResponse`. (This inconsistency is documented but intentional — the submit path records cost metrics atomically and uses a simpler non-streaming client; `pushTurnToSSE` re-chunks the cached text. We keep this pattern but will extend the submit path to emit structured-output-aware parsing; see §8.8.)

---

## 7. What Must Change (Gaps vs. Target Vision)

| Area | Current | Target | Rationale |
|---|---|---|---|
| **Orchestration decision** | Deterministic `requiredRemaining[0]` + LLM advised | LLM drives topic selection from an interview guide with Assess-Evaluate-Decide-Act loop; system validates and records decision | Core of the transformation. The queue is why interviews feel robotic. |
| **Question model** | `text, category, isActive, tags` | + `intent` (prose briefing), + `sensitivityLevel` (`standard | sensitive | highly_sensitive`); defaults preserve backward compat | Brief the LLM once, in the admin's own voice; rigid schemas force false structure |
| **Tag model** | Flat in code, typed in spec; controlled vocab | Flat in code AND spec; admin can create inline; LLM can add during enrichment; periodic normalization queue proposes merges for admin review | Aligns spec with reality and the principles; LLM-normalized tags capture more signal than a controlled taxonomy |
| **Trigger model** | Structured JSONB (`keyword/sentiment/length/always` + targetIds); LLM asked to honor; never parsed | Prose "admin notes" folded into template-question junction (soft guidance); trigger enum dropped or made read-only for legacy data | The LLM already judges triggers; the current structure costs admin time and produces no additional signal |
| **System prompt** | Minimal; question bank in full every turn; no persona | Full consultant persona + interview approach + response-handling patterns + ritual guidance, all static and cacheable; dynamic interview guide with tiered presentation | Principles document + token economics + prompt caching |
| **Prompt artifact** | Inline string in `promptConstructor.ts`; per-template override via `InterviewTemplate.systemPrompt` text column | Versioned spec at `brain/specs/interviewer-prompt-v1.md`; code references / generates from spec; bumps require ADR | New pattern per `02-OPERATIONAL-GUARDRAILS.md` §"Versioned Prompt Artifacts" |
| **Structured output** | None | `---STATE_UPDATE--- … ---END_STATE_UPDATE---` JSON block appended after the conversational response; parses to coverage updates + flagged items; tolerates parse failures | Data capture for downstream vectorization; auditability of the bot's judgment |
| **Coverage state** | `requiredRemaining[]` / `optionalRemaining[]` (pools) + `questionsAsked[]` (set) | `coveredQuestions` map (questionId → status, confidence, turn numbers, summary); `activeThreads[]`, `factsLedger`, `rapportNotes`, `conversationSummary` | Required for the Assess-Evaluate-Decide-Act loop and for graceful close-out |
| **Flagged items** | Not captured anywhere | Captured in Redis during the turn, surfaced via structured output, persisted on interview completion, emit ClickHouse event, surface in admin dashboard | Out-of-scope-but-relevant mentions are often the most valuable insights |
| **Token strategy** | Full bank every turn, no caching ordering | Static first (cacheable), dynamic after; completed questions compress to one-line status; just-in-time answer retrieval from Redis; facts ledger | Long interviews otherwise push costs and degrade focus |
| **Enrichment** | Transcription cleaning only (existing Lambda) | Sidecar enrichment job produces `topic_tags` (freeform) + `answer_type`, `confidence_level`, `sentiment`, `integration_relevance` (controlled enums) + `key_entities`, `cross_references`, `follow_up_needed` | Rich downstream data without blocking the live chat |
| **Observability** | 6 event types; none capture orchestration judgment | + `orchestration_decisions`, `coverage_transitions`, `enrichment_jobs`, `flagged_items`, `state_parse_failures` | "Why did the bot do what it did, six months later?" |
| **Admin UI** | No coverage review, no flagged items, no normalization queue, no interview-guide editing | Add all of the above; keep pill tag selector; deprecate trigger editor in favor of prose admin notes on template-question junction | Match the new data model and give non-technical PMs the surfaces they need |
| **Opening / closing** | None; first question is whatever `requiredRemaining[0]` is; completion is silent after the last response | Consultant opening ritual (introduce, set expectations, invite questions); consultant closing ritual (summarize, note gaps, open-ended "anything else?") | Spec §"Opening and Closing Rituals" — the open-ended close is often the most valuable moment |
| **Resume** | LLM context rebuilt; last response replayed via SSE; no explicit re-engagement | Warm re-establishment turn: acknowledge prior conversation, brief recap, confirm ready to continue | §"Resume" in principles |
| **Streaming mode** | `submitResponse` is non-streaming, re-chunked after the fact | Keep (it's fine — the cached text is authoritative for snapshot and SSE replay survives reconnects) | Preserves snapshot-at-submit semantics |

---

## 8. Proposed Approach

This is the recommended implementation strategy. It is structured to match the Phase 3 layer list in `00-KICKOFF.md` but proposes a reorder based on what I found in the code.

### 8.1 Proposed ordering (deviation from kickoff)

Kickoff §"Phase 3" lists layers 1–10. My proposal reorders slightly:

```
Layer A — Question data model additions (intent, sensitivity_level)         [kickoff #1]
Layer B — Tag spec reconciliation (code is right; spec lags)                 [kickoff #2 — lighter than described]
Layer C — Redis state expansion + coverage map                               [kickoff #3]
Layer D — Interviewer prompt v1 spec + code-gen integration                  [kickoff #4 partial]
Layer E — Orchestration loop + structured output + parse tolerance           [kickoff #4 main]
Layer F — Context/token strategy (tiering + caching order + JIT retrieval)   [kickoff #5]
Layer G — Flagged items persistence + admin dashboard                        [kickoff #7]
Layer H — ClickHouse event emission (all 5 new types)                        [kickoff #10]
Layer I — Async enrichment sidecar                                           [kickoff #6]
Layer J — Tag normalization job + admin review queue                         [kickoff #8]
Layer K — Admin coverage review surface                                      [kickoff #9]
```

**Why reorder:** The kickoff puts observability last. But emitting `orchestration_decisions`, `coverage_transitions`, and `state_parse_failures` as Layer H — immediately after the orchestration loop ships in Layer E — is what lets us watch the new loop's behavior and iterate. Without those events in place, Layer E ships blind. Enrichment (Layer I) is async and doesn't block anything, so it can float to after observability.

Flagged items (Layer G) move forward because they're the "deliver visible value quickly" moment — the structured output already surfaces them in Layer E, so exposing them in the admin is a short hop.

### 8.2 Data model deltas (deviation: minor; mostly additive)

- `Question`: add nullable `intent text`, add `sensitivityLevel enum('standard','sensitive','highly_sensitive') default 'standard'`. Both backfill-safe.
- `Tag`: **no change to code**. Update the spec (see §10). Close the spec-vs-code gap in the interview-spec-v2 → -v3 update.
- `TemplateQuestion`: the `followupTriggers` JSONB stays for backward compat; new work writes to a parallel `adminNotes text` field ("guidance for the AI interviewer for this question in this template"). Old triggers convert to prose via a one-time migration script (described in Phase 2 ADR).
- `InterviewResponse`: add enrichment fields as nullable columns — `answerType`, `confidenceLevel`, `sentiment`, `integrationRelevance` (all nullable enums), `keyEntities jsonb?`, `crossReferences jsonb?`, `followUpNeeded boolean?`, `followUpDescription text?`, `enrichmentStatus enum('pending','running','succeeded','failed','skipped') default 'pending'`, `enrichedAt timestamptz?`.
- New table `flagged_items`: `id, interviewId, sourceTurn int, description text, suggestedTags jsonb, priority enum('low','medium','high','critical'), needsAdminReview bool default true, dismissedAt?, convertedToQuestionId?, createdAt`.
- New table `tag_merge_proposals`: `id, status enum('pending','approved','rejected'), canonicalTag text, candidateTags jsonb (array of {label, sampleCount}), proposedAt, decidedAt?, decidedBy?` — persistence for the nightly normalization job.

### 8.3 Redis session — additive, not rewritten

Keep existing fields. Add:

```typescript
coveredQuestions: Record<string /* questionId */, {
  status: 'not_started' | 'partially_covered' | 'fully_covered' | 'skipped';
  confidence: 'low' | 'medium' | 'high';
  turnNumbers: number[];
  summary: string;
}>;

activeThreads: Array<{ topic: string; relatedQuestionIds: string[]; openedAtTurn: number }>;
flaggedItems: Array<{ description: string; sourceTurn: number; suggestedTags: string[]; priority: 'low'|'medium'|'high'|'critical' }>;
conversationSummary: string;        // maintained by compression sidecar
factsLedger: Record<string, Array<{ name: string; firstMentionedAtTurn: number }>>;  // category → entities
rapportNotes: string;
```

Backward compat: on read, if these keys are missing, default them to empty collections. No migration of existing sessions necessary — they're ephemeral and finish within 4h.

### 8.4 Orchestration loop

Pseudocode for the new `submitResponse` core:

```
1. Validate + load session + response row (unchanged scaffolding).
2. Append user turn to conversationHistory.
3. Assemble prompt:
     static persona/approach/responseHandling/ritualGuidance (cacheable),
     dynamic interviewGuide (tiered: outstanding-full, active-with-history, completed-compressed),
     dynamic state (coverageMap summary, factsLedger, activeThreads, rapportNotes, conversationSummary),
     dynamic last N turns verbatim,
     no current-question bias — the LLM picks what's next.
4. Call Claude (streaming) with prompt_caching ON for the static sections.
5. Stream tokens to SSE (existing chunker).
6. On stream close: parse ---STATE_UPDATE--- JSON block from full text.
   - On parse success: validate questionIds against known set; apply coverage updates; append flagged items.
   - On parse failure or hallucinated questionId: emit state_parse_failures; proceed with last known state; do NOT return an error to the user.
7. Emit orchestration_decisions event with chosen decisionType, sourceQuestionIds, turnNumber.
8. Write InterviewResponse row with questionTextAsAsked from currentTurnLlmText (unchanged) and per-turn cost metrics (unchanged).
9. If coveredQuestions state indicates all required questions are at 'fully_covered' or 'skipped' confidence≥medium, set interviewComplete=true in stream_complete. (Previously inferred from empty pools.)
```

This keeps the non-streaming-then-re-chunk pattern of today if we want to preserve snapshot semantics, OR we can move to true streaming on the submit path since the structured output block is at the tail and we can buffer it. My recommendation is **true streaming**, since the principles document specifies a small structured block that's easily tail-parsed, and live TTS is the user-facing win. This is a deviation I'll document via ADR in Phase 2.

### 8.5 Versioned prompt spec integration

Create `brain/specs/interviewer-prompt-v1.md` (Phase 2 deliverable). Code in `promptConstructor.ts` reads it (or a built artifact generated from it at build time) rather than hard-coding strings.

The existing `InterviewTemplate.systemPrompt` column becomes a **template-specific persona override layered on top of the v1 prompt**, not a full replacement. It appears in a section like `## Template-Specific Guidance` inside the static-cacheable region if present.

### 8.6 Trigger → admin notes migration

One-time script: for each `TemplateQuestion.followupTriggers` entry, format as:
> *"If the interviewee's answer suggests [keywords / negative sentiment / is notably brief / always], pay extra attention to the following topics: [textual descriptions of the target questions]."*

Store in `TemplateQuestion.adminNotes`. The original `followupTriggers` JSONB stays intact for one release so we can A/B and roll back; then a follow-up ADR deprecates and drops it.

### 8.7 Enrichment sidecar

New SQS queue `InterviewEnrichmentQueue` + new Lambda (shares `arena-cleaning`-style pattern but in a new handler file). Fires per-response, not per-interview — `submitResponse` publishes a lightweight EventBridge `response.submitted` event after the DB write. Lambda:
1. Loads response + ancestry (parent response if follow-up, adjacent responses in same thread).
2. Calls Claude (small model — Haiku) with an enrichment prompt.
3. Writes the enrichment columns on `InterviewResponse` and sets `enrichmentStatus='succeeded'`.
4. Emits `enrichment_jobs` ClickHouse event.
5. On failure: retries up to 3 times with exponential backoff; flags for admin review after exhausting.

Enrichment is strictly additive — the raw response remains authoritative; if enrichment never runs, nothing breaks. This matches spec §"Enrichment failure" tolerance requirement.

### 8.8 Structured output block — defensive parsing

The block is scoped between explicit delimiters so mal-formation is detectable:

```
---STATE_UPDATE---
{"coverage_updates":[...], "flagged_items":[...]}
---END_STATE_UPDATE---
```

Parsing rules:
- Delimiters missing → `state_parse_failures { parseErrorType: "missing_block" }`.
- Delimiters present, JSON invalid → `state_parse_failures { parseErrorType: "invalid_json" }`.
- JSON valid, questionId not in known set → `state_parse_failures { parseErrorType: "unknown_question_id" }`, apply valid entries, skip bad ones.
- Schema mismatch on expected fields → `state_parse_failures { parseErrorType: "schema_mismatch" }`, apply what's valid.

In all cases the conversation proceeds. The user never sees a parse error. Coverage state becomes "stale" — updated on the next successful turn.

### 8.9 Frontend (light touch)

Existing interview UI already renders the conversational response fine. The structured output block is tail-parsed server-side, stripped before the `stream_complete.fullResponse` is emitted, so the frontend sees unchanged conversation text. No client changes needed for Phase 3 layers A–E. Admin UI changes are substantial but isolated (Layers G, J, K).

### 8.10 Backward compatibility approach

All `Question` and `Template` records created before Phase 3 continue to work:
- Missing `intent` → LLM infers from `text` + tags (explicit fallback in prompt).
- Missing `sensitivityLevel` → defaults to `standard`.
- `followupTriggers` JSONB still read during transition; admin-notes migration runs on first deploy.
- Old Redis sessions (in flight during deploy) continue with pool-based logic until they complete; new sessions use coverage map. Gate via a session version field if needed.

No response data gets rewritten. Enrichment fields are null for historical responses until a backfill job runs (optional, Phase 4).

---

## 9. Proposed ClickHouse Event Schema Additions (APPROVAL GATE)

Per `02-OPERATIONAL-GUARDRAILS.md` §"Proposed New Event Types (Pending Approval)" — **no emitting code will be written until this section is explicitly approved.**

All events write to `arena_telemetry` via `clickHouseWrite()`. `event_type` is snake_case. `attributes` keys are camelCase per existing convention. Session and user IDs are pseudonymized automatically by `sanitizeForLog` (any key containing `id` is HMAC-hashed), so they appear as opaque fingerprints in the table — consistent with existing `interview_lifecycle` events.

### 9.1 `orchestration_decisions`

**Purpose:** captures every turn-level judgment the bot made. Answers "why did the bot do what it did?" months after the fact.

**When emitted:** once per turn on the submit path, after the structured-output block is parsed.

**Severity:** `INFO`. (`WARN` if decisionType=`fallback` — see error handling.)

**Attributes:**
| Key | Type | Notes |
|---|---|---|
| `interviewId` | string | pseudonymized by sanitizer |
| `templateId` | string | pseudonymized; enables template-level aggregation (per observability-enforcer review) |
| `turnNumber` | number | session turn counter |
| `decisionType` | string enum | `probe_deeper`, `pivot_related`, `move_on`, `circle_back`, `flag_out_of_scope`, `close_interview`, `fallback` (LLM emits all except `fallback`; `fallback` is system-synthesized after three consecutive parse failures) |
| `sourceQuestionId` | string | question the bot was last on (pseudonymized) |
| `targetQuestionId` | string (empty if none) | question the bot is now on (pseudonymized) |
| `openQuestionCount` | number | count of questions with status `not_started` |
| `activeThreadCount` | number | count of open threads |
| `promptTokens` | number | cost capture (already in `llm_turns` but duplicated here for orchestration-side query ergonomics) |
| `completionTokens` | number | same |
| `latencyMs` | number | same |
| `model` | string | model name |

**Emitter severity rule:** `WARN` when `decisionType='fallback'`; `INFO` otherwise. Severity must be set conditionally at the call site — do not rely on the default.

**PII note:** no summaries, no question text, no interviewee content. `decisionType` is a small controlled enum — safe. Counts are safe.

### 9.2 `coverage_transitions`

**Purpose:** trajectory analysis — which questions consistently get low confidence, which templates converge smoothly.

**When emitted:** once per coverage update applied from the structured output block. If one turn's state update contains three coverage changes, three events emit.

**Severity:** `INFO`.

**Attributes:**
| Key | Type | Notes |
|---|---|---|
| `interviewId` | string | pseudonymized |
| `questionId` | string | pseudonymized |
| `templateId` | string | pseudonymized |
| `oldStatus` | string enum | `not_started | partially_covered | fully_covered | skipped` |
| `newStatus` | string enum | same |
| `oldConfidence` | string enum (nullable) | `low | medium | high` |
| `newConfidence` | string enum | same |
| `turnNumber` | number | |
| `hasSummary` | boolean | **true if the coverage update had a summary string, never the summary itself** — satisfies the "emit about the summary not the summary" rule in §02 guardrails |
| `summaryLength` | number | character count of summary; zero if absent |

**PII note:** we emit *about* the summary (length and existence) and never the summary itself. This is the explicit "fuzzy middle zone" pattern in the guardrails doc.

### 9.3 `enrichment_jobs`

**Purpose:** observability for the async enrichment pipeline. Enrichment is invisible to users but critical to downstream vectorization — silent failures must be catchable.

**When emitted:** on job start, success, failure, and each retry.

**Severity:** `INFO` on start/succeeded/retried, `ERROR` on failed (terminal), `WARN` when retryCount > 0 on success.

**Attributes:**
| Key | Type | Notes |
|---|---|---|
| `responseId` | string | pseudonymized |
| `interviewId` | string | pseudonymized |
| `jobType` | string enum | `enrichment` (room to extend later — e.g., `compression`) |
| `status` | string enum | `started | succeeded | failed | retried` |
| `attemptNumber` | number | 1-indexed; increments on each `retried` emit for the same `responseId` (per observability-enforcer review — enables ordering of retry events) |
| `retryCount` | number | total retries on terminal events; 0 on first attempt |
| `durationMs` | number | total wall clock including retries (on terminal status) |
| `errorCode` | string enum (on failure) | **CLOSED ENUM — never a raw exception or stack trace.** One of: `llm_timeout | llm_error | invalid_response | db_write_failed | tag_limit_exceeded | unknown`. Use `unknown` as the escape hatch. |
| `model` | string (on succeeded) | |
| `promptTokens` | number (on succeeded) | |
| `completionTokens` | number (on succeeded) | |
| `entityCount` | number (on succeeded) | count of entities extracted; zero allowed |
| `tagCount` | number (on succeeded) | count of tags produced |

**Emitter severity rule:** `INFO` on `started`, `retried`, and `succeeded` with `retryCount=0`; **`WARN`** on `succeeded` with `retryCount > 0`; **`ERROR`** on `failed`. Severity must be set conditionally at the call site.

**Emitter serviceName:** must pass `{ serviceName: 'arena-enrichment' }` — this is a new registered service name introduced by this work. Update `.claude/agents/observability-enforcer.md` §"Registered Service Names" atomically with the first emitting code.

**PII note:** no entity values, no tag labels. Counts only. `errorCode` is a closed enum — never populate with `err.message` or any user-derived string.

### 9.4 `flagged_items`

**Purpose:** trends in out-of-scope discoveries — what are interviews surfacing that the question library doesn't capture?

**When emitted:** once per flagged item created. If a turn's state update flags three items, three events emit.

**Severity:** `INFO` for `low`/`medium`, `WARN` for `high`, `ERROR` for `critical`.

**Attributes:**
| Key | Type | Notes |
|---|---|---|
| `flaggedItemId` | string | pseudonymized Postgres row ID — enables correlation from ClickHouse trend to admin review queue (per observability-enforcer review) |
| `interviewId` | string | pseudonymized |
| `templateId` | string | pseudonymized |
| `sourceTurn` | number | |
| `priority` | string enum | `low | medium | high | critical` |
| `suggestedTagCount` | number | count of tags, never values |
| `descriptionLength` | number | character count; no description content |

**PII note:** critical boundary. The description is interviewee-adjacent content; we emit length only. Tag values are never emitted — only count.

### 9.5 `state_parse_failures`

**Purpose:** monitor the reliability of the bot's structured output. Low-frequency hopefully; silent failure would be catastrophic.

**When emitted:** any time the structured-output parser falls back (see §8.8).

**Severity:** `WARN` (not `ERROR` — the conversation does not break; this is a degradation signal, not a failure).

**Attributes:**
| Key | Type | Notes |
|---|---|---|
| `interviewId` | string | pseudonymized |
| `turnNumber` | number | |
| `parseErrorType` | string enum | `missing_block | invalid_json | schema_mismatch | unknown_question_id` |
| `model` | string | |
| `promptTokens` | number | |
| `completionTokens` | number | |
| `unknownQuestionIdCount` | number (when parseErrorType=unknown_question_id) | count, never the IDs themselves |
| `partialApplied` | boolean | true if some valid entries were applied despite the failure |

**PII note:** no raw LLM output, no interviewee content. `parseErrorType` is the closest we get to "what went wrong."

### 9.6 Summary: additions to the registered-events doc

On approval, I will update `.claude/agents/observability-enforcer.md` §"Registered Event Types" with the five new event types, their attribute schemas, severity rules, and emitter modules. This is an atomic change together with the first emitting code per Layer H.

### 9.7 Observability-enforcer review — incorporated 2026-04-18

The `observability-enforcer` agent reviewed this section and returned two blocking changes and three recommendations, all applied above:

- `orchestration_decisions`: added `templateId`; emitter severity rule explicit (`WARN` when `decisionType='fallback'`, else `INFO`).
- `enrichment_jobs`: `errorCode` downgraded from free-text to closed enum; added `attemptNumber`; emitter severity rule explicit (`INFO | WARN | ERROR` by status + retry count); `serviceName: 'arena-enrichment'` flagged as a new registered name requiring atomic update to `.claude/agents/observability-enforcer.md` with the first emitting code.
- `flagged_items`: added `flaggedItemId` for ClickHouse→Postgres correlation.
- `coverage_transitions` and `state_parse_failures`: approved as originally proposed.

With these changes, §9 is approved-as-revised and unblocks Layer H emitting code once Phase 1 approval is granted.

---

## 10. Identified Spec Conflicts

Each conflict is flagged explicitly (per Arena convention). **Resolutions are proposed, not applied** — they land in Phase 2 as spec updates + ADRs.

### 10.1 [ALREADY RESOLVED] `user_templates` junction vs `current_template_id` FK

- `interview-spec-v2.md` §4: use `user_templates` many-to-many junction table.
- `conversation-protocol-spec-v3.md` §8: remove `user_templates` entirely; add `users.current_template_id`.
- **CLAUDE.md resolves in favor of v2 (junction wins).** Current code uses `UserTemplate` (Prisma). No action needed. Flagging here for completeness only.

### 10.2 [NEW — must resolve] Tag model: typed in spec, flat in code

- `interview-spec-v2.md` §4: `Tag.tag_type` varchar with CHECK constraint (`role | department | topic | seniority | domain`). "Controlled vocabulary."
- Current Prisma schema (`api/prisma/schema.prisma:10-22`): no `tagType` column. Flat, label-only.
- **Proposed resolution:** code is correct; spec lags. Update `interview-spec-v2.md` §3 and §4 to remove `tag_type`. Record the change as an ADR ("Tag model — flat, disposable, LLM-normalized"). This aligns with the design principles §"Data Model: Tags."

### 10.3 [NEW — must resolve] Controlled-vocab tag creation vs LLM-added tags

- `interview-spec-v2.md` §3: "Tags are a controlled vocabulary. No freeform tag creation by non-administrators." Also codified as `CLAUDE.md` §"Immutable Technical Constraints" — **a hard rule**.
- Design principles §"Data Model: Tags": LLM adds tags aggressively during enrichment; admins and LLM create freely; normalization queue proposes merges.
- **Proposed resolution:** refine the CLAUDE.md constraint to: *"Tag creation by non-administrator **humans** is not permitted; the enrichment pipeline (backend service) may create tags, and admins review them via the normalization queue."* This preserves the intent (no end-user tag sprawl) while enabling LLM enrichment. Ship as ADR + CLAUDE.md edit.

### 10.4 [NEW — must resolve] Trigger evaluation architecture

- `interview-spec-v2.md` §3 and §9 + `conversation-protocol-spec-v3.md` §5: LLM evaluates triggers. Trigger structure (`keyword/sentiment/length/always`) passed in system prompt.
- Design principles: triggers become soft guidance folded into admin notes on the template-question junction; the structured trigger enum is deprecated.
- **Proposed resolution:** spec v2 §3 updated to describe the new model. `TemplateQuestion.followupTriggers` JSONB remains for one release with code that can read both forms; new code writes to `TemplateQuestion.adminNotes`. ADR documents the migration and deprecation timeline.

### 10.5 [NEW — must resolve] Question model additions

- `interview-spec-v2.md` §4: Question has `text, category, is_active, timestamps`. No `intent`, no `sensitivity_level`.
- Design principles: add `intent` + `sensitivity_level`.
- **Proposed resolution:** straightforward additive spec update. No code breakage.

### 10.6 [NEW — must resolve] Category semantics

- `interview-spec-v2.md` §4: each Question has a single `category`. Each `TemplateQuestion` has `category_bucket` (may differ).
- Design principles: favor prose (`intent`) and free-form tags over rigid category fields.
- **Proposed resolution:** `Question.category` becomes deprecated (kept for backward compat, displayed as read-only in admin UI). `TemplateQuestion.categoryBucket` becomes optional — used as a grouping hint in the interview guide, not a hard structural field. ADR explains.

### 10.7 [NEW — must resolve] Completion criterion

- Currently inferred from `requiredRemaining.length === 0 && optionalRemaining.length === 0`.
- New model: LLM declares completion via `decisionType: 'close_interview'` (from orchestration_decisions). Coverage state becomes the basis for progress percentage.
- **Proposed resolution:** `conversation-protocol-spec-v3.md` §3 updated to describe the new completion signal. Backward-compat: old pool-based completion still works until state migrated.

### 10.8 [RESOLVED IN CODE, DOC LAG] `question_text_as_asked` population

- Both specs say this comes from the LLM's actual output. Code is correct (`currentTurnLlmText` Redis caching).
- No conflict — just noting that the mechanism is more subtle than the spec describes; a fuller description in v3 would help future readers.

---

## 11. Identified Risks

Risks are listed by severity. Mitigations are proposals, not commitments.

**1. LLM structured-output unreliability (medium probability, high impact).**
The entire orchestration depends on the bot emitting a parseable state-update block after every conversational response. Claude is generally reliable at this with explicit delimiters and examples, but 1–3% failure rates are realistic.
*Mitigation:* defensive parsing (§8.8), `state_parse_failures` event, graceful degradation (conversation proceeds, coverage becomes stale until next successful turn). Monitor rate closely in first two weeks post-ship; if >5%, consider simplifying the structured format or moving to tool-use API.

**2. Token cost inflation (medium probability, medium impact).**
Without tiering and prompt caching, long interviews (60–120 turns) would 10× current token cost. The tiering and caching design is sound but has to actually be implemented.
*Mitigation:* prompt caching ordering is a concrete deliverable of Layer F; instrument `llm_turns` (already registered) to alert on prompt-token trajectories above a threshold per interview. Add a new alert code `INTERVIEW_PROMPT_COST_TRAJECTORY` with a per-turn ceiling.

**3. LLM tag sprawl degrading tag usability (medium probability, medium impact).**
Liberal LLM tagging will produce many near-synonyms ("NetSuite", "net-suite", "net suite ERP") within days.
*Mitigation:* the normalization queue exists for this; prioritize Layer J, not last as the kickoff suggests. Monitor `enrichment_jobs.tagCount` for outlier runs.

**4. Coverage map drift during long or resumed interviews (low probability, high impact).**
If `coveredQuestions` state diverges from what the LLM "thinks" it's covered, the bot could double-back or skip questions. Resume is especially vulnerable.
*Mitigation:* include the coverage map summary in every turn's dynamic context; on resume, prepend a "here is what has been covered so far" briefing turn; the structured-output parser validates `questionId`s against the template's known set.

**5. Spec v3 and v2 revisions creating new conflicts (medium probability, medium impact).**
We're changing both specs meaningfully. It's easy to introduce a fresh contradiction.
*Mitigation:* Phase 2 delivers spec updates in a single PR with a cross-reference audit — each change to v2 or v3 is paired with an explicit "this supersedes v2 §N / v3 §M" note. ADRs document the resolution.

**6. Backward compatibility bleeding into code complexity (medium probability, low-to-medium impact).**
Dual-reading `followupTriggers` and `adminNotes`, dual completion criteria, handling missing coverage map in old sessions — each creates a branch that must be maintained.
*Mitigation:* scoped deprecation timeline (one release transition), remove dual-read code immediately after with an ADR. Don't let the compat path become permanent scaffolding.

**7. Admin UI lag behind backend (low probability, low impact, but visible).**
Layers A–F can ship and be correct, but without Layers G/J/K the admin has no visibility into flagged items, normalization proposals, or coverage review. Early interviews under the new system will capture data the admin cannot yet see.
*Mitigation:* ship a minimal read-only admin surface for flagged items and coverage at the same time as Layer E, rather than waiting for full Phase 3 completion.

**8. Enrichment queue backlog (low probability, medium impact).**
If enrichment becomes slow or starts failing, downstream vectorization falls behind silently.
*Mitigation:* `enrichment_jobs` event + alert on `status='failed'` rate + reconciliation Lambda already runs every 15 minutes; extend its sweep to check for responses stuck in `enrichmentStatus='pending' > 1 hour`.

**9. ClickHouse volume growth from new event types (low probability, low impact).**
Five new event types, each firing multiple times per interview, multiplies telemetry volume. Existing `arena_telemetry` is MergeTree ordered by `(install_id, service_name, event_type, timestamp)` — scales fine but costs money.
*Mitigation:* estimate volume in Phase 2 planning; if concerning, `coverage_transitions` could be batched per turn (one row with an array) rather than per-coverage-update. I'd prefer per-update for query ergonomics but note the tradeoff.

**10. Prompt artifact drift (low probability, medium impact).**
The versioned prompt spec at `brain/specs/interviewer-prompt-v1.md` is meant to stay in sync with the live prompt. If code begins to append runtime ad-hoc strings, the spec becomes a fiction.
*Mitigation:* code in `promptConstructor.ts` assembles from modular section functions, each referenced to a spec section. Add a test that concatenates the assembled prompt against a fixture generated from the spec and fails on divergence.

**11. The system prompt becoming prescriptive enough to produce stilted conversation (low-medium probability, medium impact).**
We're asking for a lot: a consultant persona, an explicit reasoning loop, a structured output block, and a bunch of response-handling patterns. Under heavy instructional load, Claude sometimes produces machine-sounding output.
*Mitigation:* the Phase 4 testing phase exists for exactly this. Build 3–5 sample interview scenarios (acquired company stakeholders with varied communication styles) and walk through full transcripts before declaring done. Be willing to bump the prompt to v2 and trim if needed.

---

## Assumptions Made During Phase 1

Per the kickoff's instruction to "document your assumptions in the analysis and proceed":

1. **Audio flow is not touched.** The audio upload path, STT proxy, TTS streaming, and associated Redis fields (`currentTranscriptBuffer`) are preserved as-is and treated as opaque.
2. **EC2 / PM2 / ElastiCache topology stays.** Per kickoff §"What to Ignore" — no CDK changes.
3. **Claude model selection:** live bot uses Sonnet 4.6 (current default per API context), enrichment uses Haiku 4.5 (small, cheap, batched). Finalize in Phase 2 ADR.
4. **The `followupTriggers` JSONB migration to prose admin notes is acceptable.** Spec v2 describes the structured format in detail; I propose replacing it. If the current trigger structure carries unstated downstream value I'm not seeing (e.g., some analytics dashboard reading it), please flag.
5. **The `InterviewTemplate.systemPrompt` column remains** as a template-specific override on top of the v1 prompt. Not removed.
6. **Prompt caching is enabled** for all live-bot calls against Claude (cache_control markers on the static block). This is supported by the Claude API and reduces cost meaningfully on long interviews.
7. **No new ClickHouse tables.** All new events go into `arena_telemetry` with new `event_type` values per `02-OPERATIONAL-GUARDRAILS.md`.
8. **Structured output via text delimiters, not tool use.** Tool use would be more reliable but changes the streaming semantics and TTS-sentence-chunking path. Phase 2 ADR should explicitly weigh this tradeoff; my default recommendation is text delimiters with parse tolerance because it preserves the existing SSE path.
9. **Enrichment events fire from a new SQS queue, not in-line.** Keeps the live path fast. Matches the existing cleaning-pipeline pattern.
10. **The `elastichorizon` vs `Arena` naming** applies — new code uses `Arena`/`arena-*`, public-facing copy uses `elastichorizon`.

---

## Request to Proceed

This document is the Phase 1 deliverable. Phase 2 (Design) is gated on approval of:

- **§8** (proposed approach), especially the reordering in §8.1 and the structured-output design in §8.4 + §8.8.
- **§9** (new ClickHouse event types) — **hard gate per `02-OPERATIONAL-GUARDRAILS.md`; no emitting code will be written until this section is explicitly approved.**
- **§10** (spec-conflict resolutions proposed but not applied).
- **The assumptions list** above, especially #3 (model selection), #4 (trigger migration), #8 (text delimiters vs tool use).

On approval, Phase 2 produces:
- ADRs for each significant decision (tag flattening, sidecar enrichment, context tiering, structured output, versioned prompt, live/async split, completion criterion).
- `brain/specs/interviewer-prompt-v1.md` (the new versioned artifact).
- Updates to `interview-spec-v2.md` and `conversation-protocol-spec-v3.md` for the items in §10.
- `brain/architecture/current-state.md` and `changelog.md` updated alongside.
- Detailed designs for each of Layers A–K in §8.1.
