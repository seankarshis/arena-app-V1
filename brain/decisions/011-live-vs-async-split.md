# ADR 011 — Live Turn Work vs Async Enrichment Split

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR 008 (orchestration loop), ADR 012 (async enrichment sidecar)

## Context

Each interview turn has a latency budget dictated by conversational feel: the interviewee speaks, the bot must respond within roughly 2-4 seconds for the interaction to feel natural. Anything slower and the interviewee either repeats themselves (derailing the rhythm) or the bot feels laggy. At the same time, ADR 008's orchestration loop wants the LLM to do substantially richer work than the current engine — assess coverage, maintain a facts ledger, emit tags, flag out-of-scope items, update summaries. If all of this runs on the critical path of the turn, latency budgets blow out.

The design principle (`01-DESIGN-PRINCIPLES.md` §"Async Enrichment") resolves this by splitting work across two phases: what must happen before the bot can respond, and what can run after the response is already on its way to the interviewee. The split is not obvious for every piece of metadata — what shape of ledger update does the next turn need? what tags must be resolved before the next turn's prompt renders? — so we define it explicitly here.

## Decision

**Live path (blocks turn completion):** orchestration decision (`decisionType`, `sourceQuestionId`, `targetQuestionId`), coverage updates for the source question only, the conversational response text, and detection of `flag_out_of_scope` or `close_interview` signals. These four items are what the next turn's prompt and the frontend's next render depend on, and they all come out of the state-update block the LLM emits (ADR 009). Parsing, Zod validation, Redis coverage-map write, and SSE completion happen before the turn lock releases. Total added work vs. today's engine: one parse, one validation, one Redis HSET — all sub-millisecond.

**Async path (enqueues after SSE end):** full facts-ledger entry extraction, cross-question coverage updates (questions the utterance touched incidentally), tag enrichment, entity extraction, flagged-item classification refinement, summary regeneration for `fully_covered` questions, and any future enrichment we layer on. These run via the sidecar (ADR 012) on a separate service with its own SLA. The sidecar writes back to Postgres (`InterviewResponse` enrichment columns) and updates the facts ledger in Redis, but never blocks the live turn.

The hand-off is a single SQS message enqueued after the live turn's Postgres write commits. The message carries `interviewId`, `responseId`, `turnNumber`, and a reference to the raw assistant/user text (by responseId — no PII in the message itself). The live path does not wait for enqueue confirmation; the enqueue is inside the same transaction as the response write via an outbox pattern (a lightweight `enrichment_outbox` table polled by a small sidecar dispatcher). If the enqueue fails, the outbox row stays pending and a later poll retries — the interview continues regardless.

## Consequences

Live turn latency stays at `stream-time + (few-ms bookkeeping)`, which is essentially what the current engine spends. The new orchestration cost is entirely on the LLM call's token count, not on post-processing. This means we can roll out ADR 008's richer reasoning loop without a latency regression — the budget we might have spent on post-processing goes into prompt and response tokens instead, where it directly buys interview quality.

The async path has an eventual-consistency window. If turn N produces facts that the sidecar hasn't yet written to the ledger when turn N+1 starts, the LLM's prompt on turn N+1 may not include those facts. In practice the sidecar completes in 1-3 seconds per response (Haiku model, small prompts), and the interviewee typically takes longer than that to produce their next utterance, so in the common case the ledger is current by the time the next prompt renders. In the edge case where the interviewee responds instantly, the next turn's LLM has the raw recent-turns window (last 16 messages) and the coverage map — it has the data, just not the compressed ledger form of it. This is acceptable: the ledger is an efficiency optimization, not a correctness requirement.

A failure mode: the sidecar is down or falls behind and the enrichment outbox grows. The live interview continues working — coverage updates from the live path still happen, interviews still close, responses still persist. What's missing is the denormalized ledger entries and the enrichment-side tag/entity/summary fields on `InterviewResponse`. Admin-side analytics that depend on those fields show stale or missing data until the sidecar catches up. We monitor outbox depth as a SLO (`enrichment_outbox_depth` gauge emitted to ClickHouse every 30s); sustained depth above a threshold pages, but interviews are unaffected.

If we later need a piece of metadata on the critical path that today runs async — say, tag-based branching becomes a product requirement — we promote that one piece of work into the live path's state-update block and leave everything else async. The split is not a one-shot decision; it's a line we can move per-item as product requirements evolve.
