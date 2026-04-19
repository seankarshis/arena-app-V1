# ADR 009 — Structured Output via Text Delimiters, Not Tool Use

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR 008 (orchestration loop), ADR 014 (ClickHouse event types)

## Context

ADR 008 requires the LLM to emit an orchestration decision each turn: a `decisionType`, coverage updates, flagged items, and target question identifiers. Two API-level mechanisms can carry this structured output. The first is Anthropic's tool use API, where the model calls a named tool and the SDK returns a parsed JSON argument object. The second is freeform text with the model trained to emit a delimited block the backend parses itself.

Tool use is the orthodox choice for structured extraction. It is also incompatible, at the shape we need, with the existing SSE streaming path. The interview engine streams assistant text to the frontend token-by-token (`api/src/services/interviewEngine.ts` — `pushTurnToSSE` chunks on sentence boundaries for TTS), and the frontend state machine renders the response as it arrives. Tool use forces a mode where the model either emits a tool call OR text, and in streaming mode the JSON argument block arrives interleaved with content in a way the current SSE fan-out is not built to split. Retrofitting tool use would require reworking the streaming path, the TTS chunker, and the frontend reducer at the same time we're changing orchestration semantics — three risky changes at once.

## Decision

The LLM emits its conversational response first, followed by a `---STATE_UPDATE---` / `---END_STATE_UPDATE---` delimited block containing a single JSON object. The prompt instructs the model to always close the block before finishing. The backend accumulates the full streamed response, then post-stream splits on the delimiters and parses the JSON. The conversational portion (everything before `---STATE_UPDATE---`) is what gets streamed to the frontend and passed to TTS; the state-update block is consumed server-side only.

The state-update JSON schema is:

```json
{
  "decisionType": "probe_deeper | pivot_related | move_on | circle_back | flag_out_of_scope | close_interview",
  "sourceQuestionId": "uuid | null",
  "targetQuestionId": "uuid | null",
  "reasoning": "string (brief — for telemetry, not rendered)",
  "coverageUpdates": [
    { "questionId": "uuid", "status": "not_started | partially_covered | fully_covered | skipped", "confidence": "low | medium | high", "summary": "string" }
  ],
  "flaggedItems": [
    { "description": "string", "priority": "low | medium | high", "suggestedTags": ["string"] }
  ]
}
```

Parsing is defensive. Four failure modes are tracked as the `state_parse_failures` ClickHouse event (ADR 014), each with a closed-enum `errorCode`: `missing_block` (no `---STATE_UPDATE---` found), `invalid_json` (delimiters present, JSON malformed), `schema_mismatch` (JSON parses, fails Zod validation), `unknown_question_id` (a questionId is not in the template's known set). On any failure, the conversational response is still delivered to the interviewee — the turn never breaks. Coverage state and the decision log stay at their prior values until the next successful turn. If three consecutive turns fail parsing, the orchestrator falls back to the completion criterion check against existing coverage and may close the interview if required questions are already satisfied; otherwise a synthetic `move_on` decision is recorded with `confidence: low` and an `orchestration_decisions` event with `severity: warn`.

## Consequences

Existing streaming, chunking, and TTS paths stay untouched. The only new code is the post-stream parser (one function, ~60 lines including the Zod schema and the four error paths) and a small prompt section instructing the model on the delimiter protocol. The non-streaming `submitResponse` path (used for test harnesses and the reconciliation replay) reuses the exact same parser on the accumulated text — one implementation serves both.

The cost is that we spend tokens on a structured block the model must learn to produce reliably. Empirically, Claude models follow delimiter conventions well when the prompt is explicit about format and provides a filled example; the interviewer-prompt-v1 spec (ADR 013) includes a worked example as the final section of the prompt for exactly this reason. Parse failures are directly observable via `state_parse_failures` grouped by `errorCode`, which is the signal we monitor post-launch to tune prompt wording if we see `invalid_json` or `schema_mismatch` trending above ~1% of turns.

A secondary benefit of delimiters-over-tools: the state block is readable as plain text in any log line that captures the raw model output (for debugging) without special SDK handling. When an admin reviews a failed turn in the post-interview coverage review surface (Phase 3 Layer K), they can see exactly what the model meant to emit, even if parsing failed — which makes prompt iteration substantially easier than it would be with opaque tool-call objects.

If the model's delimiter reliability turns out worse than projected and prompt iteration doesn't close the gap, the fallback is to migrate to tool use and do the SSE rework then — not now. That is a deliberate deferral: ship the simpler change first, measure, rework only if data says we must.
