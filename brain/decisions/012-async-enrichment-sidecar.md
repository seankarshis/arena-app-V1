# ADR 012 — Async Enrichment Sidecar Service

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR 005 (tag model + enrichment-created tags), ADR 011 (live vs async split), ADR 014 (ClickHouse event types)

## Context

ADR 011 defines the live-vs-async split: the live turn handles orchestration and the primary response-text write, while enrichment (facts-ledger extraction, cross-question coverage inference, tag generation, entity extraction, summary refresh) runs async. That decision needs a concrete home — something that polls the enrichment outbox, runs LLM calls per response, writes results back, and handles retries and failures. It also needs to fit the deployment story: EC2 + PM2 is the current compute target (per ADR 004), and CDK stacks are coded but not deployed.

Three placement options exist. Option A: run enrichment as a worker inside the Fastify API process, shared loop, shared memory. Option B: run enrichment as a separate Node.js process on the same EC2 host, managed by PM2 alongside the API. Option C: run enrichment as a Lambda triggered by SQS, following the same pattern as the existing cleaning and reconciliation Lambdas. Option A couples enrichment latency to API memory pressure; Option C is consistent with existing Lambda patterns; Option B is a middle ground with lower operational overhead in Phase 3.

## Decision

Enrichment is a Lambda triggered by SQS (Option C), following the pattern of the existing `arena-cleaning` and `arena-reconciliation` Lambdas. The new service is named `arena-enrichment` and registers as such in observability emissions (enforcer registration updated in one commit with the first code that writes the event — see ADR 014).

The pipeline: the live turn writes to Postgres and inserts a row into `enrichment_outbox` in the same transaction. A lightweight outbox dispatcher (a small loop inside the Fastify process, or a dedicated tiny process — implementation detail for Phase 3) polls the outbox, publishes to SQS, and marks the row dispatched. The Lambda consumes from SQS, loads the `InterviewResponse` by id, runs a structured enrichment prompt against Claude Haiku (the small-fast model is sufficient — enrichment is extraction, not reasoning), parses the JSON output, and writes back: facts-ledger entries to the session's Redis `ledger` list, `extractedTags[]` and `entities[]` and `summary` columns to the InterviewResponse row, cross-question coverage updates applied to the session's coverage map via optimistic concurrency (re-read, merge, CAS write).

The enrichment prompt is its own versioned artifact (`brain/specs/enrichment-prompt-v1.md`, spec is a Phase 3 write task not covered here). It is distinct from the interviewer prompt: different model, different tone, different output schema. Shared prompt infrastructure is limited to the versioned-artifact pattern (ADR 013); the two prompts do not share content.

Retries: SQS visibility timeout 2 minutes, max receive count 3. On first or second failure, the message returns to the queue; on third, it lands in a DLQ that emits a `enrichment_jobs` event with `errorCode` from the closed enum (`llm_timeout | llm_error | invalid_response | db_write_failed | tag_limit_exceeded | unknown`) and `attemptNumber: 3`. The response itself is never dropped — its primary write already happened in the live path; what's missing is the enrichment fields, which stay null and can be backfilled by a reconciliation pass.

## Consequences

The cleaning Lambda already proves the SQS → Lambda → Postgres pattern works in this codebase, and the deployment story (CDK construct, IAM policy template, log pipeline to ClickHouse) is fully-formed. Replicating it for enrichment is a known-shape project, not a novel infrastructure build. Per-response enrichment cost on Haiku is sub-cent; volume scales with response count, so total spend ties to actual interview activity rather than interviewee pacing.

The outbox dispatcher is an implementation wrinkle. If we put it inside Fastify, we accept that dispatcher health is tied to API health — acceptable because if the API is down, no new interview turns are happening and the outbox isn't growing. If we split it into its own PM2-managed process, we add a deployment unit. Phase 3 defaults to the Fastify-embedded option for simplicity; we promote it to a separate process only if we see dispatcher-related issues.

A meaningful tradeoff: by choosing Lambda over an always-on worker, we accept cold-start latency on the first enrichment after idle. Haiku calls are fast enough that a 300ms cold start is invisible in the context of enrichment's 1-3 second total budget, and interview traffic patterns keep the Lambda warm during active interviews. If idle cold-start ever becomes an enrichment-backlog problem, provisioned concurrency is the mitigation.

The enrichment Lambda writes tags via the existing `Tag` model (see ADR 005 — enrichment service is the authorized system creator). Newly-created tags flow through the audit log with `tag.create.by-enrichment` event type, which feeds the admin's tag-normalization queue. This keeps enrichment-created tags visible and reviewable without blocking their creation.
