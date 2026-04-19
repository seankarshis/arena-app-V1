# Conversation Protocol Spec — v4 (Runtime Bump for LLM-Driven Orchestration)

**Status:** Active
**Supersedes:** `conversation-protocol-spec-v3.md` sections called out below. All other v3 sections remain authoritative.
**Date:** 2026-04-18
**Related ADRs:** 007 (trigger migration), 008 (orchestration loop), 009 (structured output), 010 (context tiering), 011 (live vs async split)

---

## How to read this spec

This is a **diff-style supersede** of v3. Each section below names a v3 section and states what changes. Sections of v3 not listed here are unchanged and authoritative. When v4 and v3 conflict, v4 wins. When v4 is silent, v3 is the source of truth.

A known conflict between v3 and `interview-spec-v2.md` concerning `user_templates` was already resolved in `CLAUDE.md` (junction table wins). v4 makes no change there; §8 of v3 (as-written) remains overridden by interview-spec v2/v3.

---

## Changes

### §3 (Frontend State Machine) — unchanged in v4

The frontend state machine is not affected by the orchestration change. The frontend still submits a response via `submitResponse` and streams the assistant reply via SSE. What changes is what the backend does *inside* the turn lock, not the protocol the frontend observes. v3 §3 remains authoritative.

### §4 (Message Sequence — Complete Turn Cycle) — MODIFIED

**Modifies:** v3 §4.1 and §4.2 (voice and text turn cycles), specifically the backend-side orchestration between "submit received" and "SSE stream complete."

Previously, the backend flow was:
1. Acquire turn lock.
2. Call the LLM with the current prompt.
3. Stream assistant tokens to SSE.
4. On completion, call `getNextQuestion(session)` to select the next question head-of-queue and advance pool state.
5. Persist the response row with snapshot fields.
6. Release the turn lock.

New flow (ADR 008 + ADR 009):
1. Acquire turn lock.
2. Assemble Tier 1 + Tier 2 prompt via `buildPrompt(session, promptVersion)` (ADR 010). Tier 1 carries `cache_control: ephemeral` on its trailing boundary.
3. Call the LLM. Stream the pre-delimiter portion of the response to SSE as it arrives. Accumulate the full response text server-side.
4. On stream completion, split the accumulated text on `---STATE_UPDATE---` / `---END_STATE_UPDATE---`. The conversational portion was already streamed; the state block is parsed server-side.
5. Validate the state block against the Zod schema. Validate each `questionId` against the template's known set.
6. Apply coverage updates to the Redis coverage map. Persist `flaggedItems` rows. Record the orchestration decision (decisionType, source/target questionIds).
7. Persist the response row with snapshot fields (`questionTextAsAsked` from `currentTurnLlmText`, `questionId` from `sourceQuestionId` in the state block). Insert the `enrichment_outbox` row in the same transaction.
8. Emit ClickHouse events: `orchestration_decisions` (always), `coverage_transitions` (one per coverage update), `flagged_items` (one per flagged item), `state_parse_failures` (if the block failed to parse).
9. Release the turn lock.
10. Return the `SubmitResponsePayload` to the frontend. The SSE stream has already completed; this mutation response is the ack-plus-metadata.

**Parse-failure path** (any of: missing_block, invalid_json, schema_mismatch, unknown_question_id): the conversational response was already streamed and the interviewee sees it; the turn does not visibly fail. Coverage remains at its prior values. A `state_parse_failures` event emits. If three consecutive turns fail parsing on the same interview, the orchestrator synthesizes a `move_on` decision with `confidence: low` and emits an `orchestration_decisions` event with `severity: warn` and `decisionType: 'fallback'`.

**Completion path** (LLM emits `decisionType: 'close_interview'`): the backend marks the interview `complete` after the response persists. The frontend receives this via the normal SSE completion plus the mutation payload's `interviewStatus: 'complete'` field. Completion validation happens after the LLM's signal — backend rejects a `close_interview` if required questions remain `not_started` or `partially_covered` with `confidence: low`, and instead demotes the decision to a logged anomaly (emits `orchestration_decisions` with `severity: warn`, `decisionType: 'fallback'`). In practice this should be vanishingly rare — the prompt instructs the LLM to complete coverage before closing.

### §5 (Data Flow Per Turn) — MODIFIED

**Modifies:** v3 §5.

**Redis Session Structure — changes:**

Removed:
- `requiredRemaining: string[]`
- `optionalRemaining: string[]`
- `triggeredFollowups: { triggerType, fromQuestionId, targetQuestionIds }[]` (analytics-only in current code; reconstructable from `orchestration_decisions` ClickHouse events if ever needed)

Added:
- `coverage: Record<questionId, { status: 'not_started' | 'partially_covered' | 'fully_covered' | 'skipped', confidence: 'low' | 'medium' | 'high' | null, turnNumbers: number[], summary: string | null }>`
- `activeThreads: { topic: string, openedAtTurn: number, questionIds: string[] }[]`
- `factsLedger: { id: string, text: string, sourceTurn: number, questionIds: string[] }[]` (populated by the async enrichment sidecar — ADR 012)
- `rapportNotes: string[]` (short free-form observations, written by the bot via state-update, optional)
- `sessionVersion: 'v1-pool' | 'v2-coverage'` (migration gate — see below)
- `consecutiveParseFailures: number` (reset to 0 on any successful parse)

Unchanged:
- `interviewId`, `userId`, `templateId`, `turnNumber`, `isStreaming`, `currentTurnLlmText`, `heartbeatAt`, `draftId`, audio buffer fields.

**Redis Session TTL**: unchanged (v3 §5 — 4 hour sliding TTL).

**Migration/transition**: existing sessions in Redis at deploy time carry no `sessionVersion` field. The orchestration entrypoint reads `sessionVersion ?? 'v1-pool'` and routes to the legacy code path. New sessions created after deploy start as `'v2-coverage'` and use the new orchestration. Legacy sessions drain naturally via TTL (4 hours); one release cycle after deploy, the v1 code path is removed.

### §6 (Follow-Up Trigger Evaluation) — REPLACED

**Replaces:** v3 §6 in full.

Triggers are no longer structured objects rendered as bullet points at the end of each question's prompt line. Admin guidance for a specific template-question is now prose in `TemplateQuestion.adminNotes`, rendered directly as "Admin notes:" lines in the interview guide (see `interviewer-prompt-v1.md` §"Tier 2 dynamic context").

The orchestration decision — to probe deeper, pivot, move on, circle back, or flag — is the LLM's own, declared each turn in its state-update block (ADR 008 / 009). There is no evaluation step on the application side; the decision arrives pre-parsed.

For in-flight data still carrying the old `followupTriggers` JSONB during the deprecation window (ADR 007), a one-time migration script translates them into prose in `adminNotes`. After the window closes, the JSONB column is dropped.

### §7 (Response Drafts — Silent Redo Tracking) — unchanged

v3 §7 remains authoritative. Drafts are orthogonal to orchestration.

### §8 (User-to-Template Assignment Model) — NEUTRALIZED

v3 §8 is overridden by `interview-spec-v2.md` §4 / `interview-spec-v3.md` (the `user_templates` junction table wins — see CLAUDE.md). v4 makes no change; this section is listed only to reiterate the known conflict and its resolution.

### §10 (Pause and Resume Protocol) — MODIFIED

**Modifies:** v3 §10.

Pause is unchanged. Resume must re-hydrate the new session fields: on resume, the full coverage map, active threads, facts ledger, and rapport notes are re-loaded from Redis (or reconstructed from the persisted response rows if Redis has expired). If the Redis session is gone and reconstruction is required, the backend rebuilds coverage by replaying `interview_responses` for the interview in order and setting each answered question's status to `partially_covered` with `confidence: medium` as a conservative default — the LLM refines on the first post-resume turn.

Facts ledger reconstruction from durable storage is a Phase 4 concern (the ledger lives in Redis; if Redis is lost, ledger entries are lost). For Phase 3, acceptable behavior on a ledger-lost resume is "empty ledger, repopulated asynchronously as subsequent turns feed enrichment." Interview quality degrades slightly across the gap; correctness is not affected.

### §11 (Inactivity Handling) — unchanged

v3 §11 remains authoritative. Idle timer, heartbeat, and resumption semantics are unaffected.

### §12 (Security Considerations) — unchanged

v3 §12 remains authoritative.

### Atomic turn lock — explicitly preserved

The `isStreaming` Redis flag (set at lock acquisition, cleared at turn completion, reset by the reconciliation Lambda on 60s staleness) is unchanged. ADR 008 changes what runs *inside* the lock, not the locking itself. The reconciliation Lambda's stale-lock sweep and the 60s threshold are unchanged.

---

## What did NOT change

- Three-channel architecture (REST + SSE + WebSocket). Audio routing over S3 presigned URLs. ElevenLabs usage patterns. Audio burst handling in the Fargate proxy. Recording duration caps. Draft audio upload. Audio lifecycle policy.
- The entire frontend state machine (§3).
- The data flow shape (`submitResponse → LLM → SSE → persist → release lock`). Only the internals of "LLM → persist" step changed.
- Pause/resume mechanics except for the session-field hydration above.
- WebSocket auth, SSE auth, TTS API key handling, presigned URL security.
- Skip flow (§4.3) — skip remains a first-class intent from the frontend and persists a response row with `status: 'skipped'`; it interacts with the new coverage map by setting that question's status to `'skipped'` but does not go through the LLM orchestration path.

---

## Implementation entry points

For engineers implementing v4 in Phase 3, the load-bearing surfaces are:

- `api/src/services/interviewEngine.ts` — `submitResponse` rewrite inside the turn lock.
- `api/src/services/promptConstructor.ts` — replaced by `buildPrompt` taking `(session, promptVersion)` and returning `{ system, messages }` per ADR 010.
- `api/src/services/stateUpdateParser.ts` — new file implementing ADR 009's parser.
- `api/src/services/stateManager.ts` — replace `getNextQuestion`, `applyFollowupTriggered`, and the pool-mutation paths with coverage-map operations.
- `api/src/observability/events.ts` (or wherever emitters live) — five new emitter functions, one per new event type.
- Prisma migration adding `intent`, `sensitivityLevel`, `adminNotes`, `flagged_items`, `tag_merge_proposals`, `enrichment_outbox`.

Each is small in isolation. The coordination is the work.
