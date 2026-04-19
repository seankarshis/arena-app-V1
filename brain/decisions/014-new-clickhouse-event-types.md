# ADR 014 — Five New ClickHouse Event Types for the Orchestration Loop

**Status:** Accepted (pending approval gate per §02 guardrails — schema approved in Phase 1; emitting code lands with Layer H in Phase 3)
**Date:** 2026-04-18
**Related:** ADR 008 (orchestration loop), ADR 009 (structured output parsing), ADR 011 (live vs async), ADR 012 (enrichment sidecar)

## Context

The six existing ClickHouse event types (`interview_lifecycle`, `llm_turns`, `stt_session`, `cleaning_metrics`, `cleaning_summary`, `reconciliation_run`) capture cost, latency, and lifecycle state but say nothing about orchestration judgment. With ADR 008 shifting the engine from deterministic queue to LLM-driven reasoning, the central new question we need answered at query time is "*why did the bot do what it did, and how well did it do it?*" — and none of the existing events have an attribute surface that answers that. Additionally, ADR 009 (structured output) and ADR 012 (async enrichment) introduce two new failure surfaces — parse failures and enrichment job failures — that must be observable without PII leakage.

§9 of `INTERVIEW_BOT_ANALYSIS.md` (at `brain/tasks/interview-bot-transformation/`) proposes five new event types. The observability-enforcer agent reviewed and returned two blocking changes and three recommendations; all were applied before the schema was marked approved-as-revised. This ADR records the final schema so it can be implemented directly from one source when Layer H ships.

## Decision

Five new `event_type` values join the `arena_telemetry` table, all written via the existing `clickHouseWrite()` pipeline with `sanitizeForLog` handling ID pseudonymization automatically. Naming is snake_case per existing convention; attribute keys are camelCase.

**`orchestration_decisions`** — one event per turn after the structured-output block parses. Attributes: `interviewId`, `templateId`, `turnNumber`, `decisionType` (closed enum: `probe_deeper | pivot_related | move_on | circle_back | flag_out_of_scope | close_interview | fallback` — the LLM emits all except `fallback`; `fallback` is system-synthesized after three consecutive parse failures per ADR 009), `sourceQuestionId`, `targetQuestionId`, `openQuestionCount`, `activeThreadCount`, `promptTokens`, `completionTokens`, `latencyMs`, `model`. Severity: `WARN` when `decisionType='fallback'`, else `INFO` — conditional at call site.

**`coverage_transitions`** — one event per coverage update applied. Attributes: `interviewId`, `questionId`, `templateId`, `oldStatus`, `newStatus`, `oldConfidence` (nullable), `newConfidence`, `turnNumber`, `hasSummary` (boolean — never the summary string), `summaryLength`. Severity: `INFO`. This is the canonical illustration of the "emit *about* the data, not the data" guardrail: we capture whether a summary existed and how long it was, never its content.

**`enrichment_jobs`** — emitted on job `started | succeeded | failed | retried`. Attributes: `responseId`, `interviewId`, `jobType` (enum: `enrichment`, extensible), `status`, `attemptNumber` (1-indexed), `retryCount`, `durationMs`, `errorCode` (**closed enum** — `llm_timeout | llm_error | invalid_response | db_write_failed | tag_limit_exceeded | unknown`; never a raw exception or stack trace), `model`, `promptTokens`, `completionTokens`, `entityCount`, `tagCount`. Severity: `INFO` on `started|retried|succeeded-with-retryCount-0`; `WARN` on `succeeded` with `retryCount>0`; `ERROR` on `failed`. Service name: `arena-enrichment` — a new registered name added atomically to `.claude/agents/observability-enforcer.md` §"Registered Service Names" with the first emitting commit.

**`flagged_items`** — one event per flagged item created. Attributes: `flaggedItemId` (Postgres row id, pseudonymized, for ClickHouse→Postgres correlation to the admin review queue), `interviewId`, `templateId`, `sourceTurn`, `priority` (enum: `low | medium | high | critical`), `suggestedTagCount`, `descriptionLength`. Severity: `INFO` for `low|medium`, `WARN` for `high`, `ERROR` for `critical`. The description string and tag values never leave Postgres.

**`state_parse_failures`** — emitted whenever ADR 009's parser falls back. Attributes: `interviewId`, `turnNumber`, `parseErrorType` (closed enum: `missing_block | invalid_json | schema_mismatch | unknown_question_id`), `model`, `promptTokens`, `completionTokens`, `unknownQuestionIdCount` (when applicable), `partialApplied` (boolean). Severity: `WARN` — the conversation does not break, so this is a degradation signal, not an error.

## Consequences

Query ergonomics come first. Aggregating "distribution of decisionTypes by template" is a one-line SQL; cross-joining `orchestration_decisions` and `llm_turns` on `interviewId` + `turnNumber` answers "how did the bot decide and what did it cost." Trending `state_parse_failures` by `parseErrorType` tells us whether to tune the prompt or rework the parser. The `enrichment_jobs.errorCode` closed enum means we can alert on `errorCode = 'llm_timeout' AND count > threshold` without worrying about cardinality explosion from free-text error strings.

Writeable volume grows modestly. For a 30-question interview averaging 60 turns with ~2 coverage updates per turn, one interview emits ~60 orchestration events + ~120 coverage transition events + ~60 enrichment events + a handful of flagged items + (hopefully zero) parse failures — call it 250 events per interview. Existing `interview_lifecycle` + `llm_turns` + `stt_session` already emit on similar orders of magnitude. ClickHouse handles this comfortably at the scale we're running; no partitioning or schema change is needed.

Implementation discipline: every emitter must pass severity explicitly (no reliance on defaults), must use the closed enums as-specified, and must never populate any attribute from interviewee content, question text, or LLM response body. The observability-enforcer agent reviews every new emitter against these rules. The registered-events section of the enforcer config updates atomically with the first emitting PR — a commit that adds the event type to the doc and adds the first `clickHouseWrite` call should land together, not in separate PRs.

The approval gate referenced in §02 guardrails is satisfied by this ADR plus §9.7 of `brain/tasks/interview-bot-transformation/INTERVIEW_BOT_ANALYSIS.md` (enforcer review record). Layer H emitting code is unblocked once Phase 1 approval is granted, which it has been.
