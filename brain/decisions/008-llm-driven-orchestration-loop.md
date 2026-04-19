# ADR 008 — LLM-Driven Orchestration Loop Replaces Deterministic Queue

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes (in part):** `conversation-protocol-spec-v3.md` §3 (turn lifecycle), §4 (system prompt construction)
**Related:** ADR 009 (structured output format), ADR 010 (context tiering), ADR 013 (prompt artifact)

## Context

The Phase 1 analysis (§1.3, §4) documented the central finding: despite appearing LLM-driven, the current engine selects each next question deterministically via `getNextQuestion(session) = requiredRemaining[0] ?? optionalRemaining[0]`. The LLM receives all remaining questions and triggers in every turn's prompt and is told to honor them "in your judgment," but its output is never parsed for orchestration signals. The queue always picks the head of the remaining pool. This is why interviews feel robotic even with the right model and tokens — the selection mechanism is deterministic and the LLM's conversational framing can't fully compensate.

The target vision (kickoff mission + `01-DESIGN-PRINCIPLES.md` §"The Orchestration Model") is a consultant-grade reasoning loop where the LLM actually drives: **Assess** what the interviewee said → **Evaluate** coverage (what's fully/partially/not covered) → **Decide** (probe deeper, pivot to related question, move on, circle back, flag out-of-scope item, close) → **Act** by formulating the next response naturally.

## Decision

Remove `getNextQuestion` from the live path. Replace the pool-based orchestration with a reasoning loop where the LLM:

1. Receives the static persona + interview approach + response-handling patterns (cacheable — see ADR 010) followed by the dynamic interview guide, coverage map, facts ledger, active threads, rapport notes, and recent conversation turns.
2. Produces a conversational response and a structured state-update block (see ADR 009) declaring its decision: `decisionType`, `sourceQuestionId`, `targetQuestionId`, plus per-question coverage updates and any flagged items.
3. The backend parses the state-update block, validates `questionId`s against the template's known set, applies coverage transitions, appends flagged items, and records the `orchestration_decisions` telemetry event.

The session's coverage state (in Redis, see `conversation-protocol-spec-v4.md`) replaces `requiredRemaining[]` / `optionalRemaining[]`. Coverage is a `Record<questionId, { status, confidence, turnNumbers[], summary }>` where status is `not_started | partially_covered | fully_covered | skipped`. The interview's notion of "done" shifts from "both pools are empty" (current) to "all required questions are `fully_covered` with confidence ≥ `medium`, OR `skipped` with explicit LLM acknowledgement" (new), plus an explicit LLM `decisionType: 'close_interview'` signal. See ADR 011 for the full completion criterion.

The existing atomic turn lock (`isStreaming` Redis flag) is preserved unchanged — this ADR only changes what runs inside the lock, not the locking itself. The existing snapshot mechanism (`question_text_as_asked` sourced from `currentTurnLlmText`) is also preserved; `sourceQuestionId` in the LLM's state-update block tells us which question the current turn answered, which is what `questionId` on the response row now records.

## Consequences

Interviews stop feeling queued. The LLM can stay on a topic across three turns if the interviewee keeps opening useful angles, transition smoothly when a thread dries up, and explicitly circle back to an earlier topic with new context — behaviors the deterministic queue cannot produce. The tradeoff is that orchestration quality now depends on the LLM's structured output reliability. ADR 009 covers the defensive parsing; the `state_parse_failures` ClickHouse event covers the monitoring.

Code deletions are substantial: `stateManager.getNextQuestion`, the `requiredRemaining`/`optionalRemaining` mutation paths, the `applyFollowupTriggered` analytics-only function, and the "move on from head of queue" branch in `submitResponse`. Session state gains fields per the v4 runtime spec. Tests covering the old pool arithmetic are deleted or rewritten against the coverage-map model.

Backward compatibility for in-flight sessions during deploy: old sessions running on pool-based logic continue to completion via the old code path, gated by a `sessionVersion` field that defaults to `'v1-pool'` for existing Redis sessions and `'v2-coverage'` for new ones. The old code path is removed one release after deploy once all pool-based sessions have drained (Redis TTL is 4h; one release cycle is sufficient).

Observability consumes the new `orchestration_decisions` event as its primary query surface. The existing `llm_turns` event continues unchanged (it captures cost and latency per turn, which the new orchestration also needs). The two events correlate on `interviewId` + `turnNumber` for any analysis asking "how did the bot decide, and what did it cost."

A meaningful risk is that the LLM's sense of "fully covered" may diverge from an admin's. Admins gain a post-interview coverage review surface (Phase 3 Layer K) where they can disagree with the bot's confidence calls and mark questions as `partially_covered` manually. That surface is the corrective feedback loop; over time it also produces training signal for prompt iteration.
