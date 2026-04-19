# ADR 010 — Context Tiering and Prompt Caching Layout

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR 008 (orchestration loop), ADR 013 (versioned prompt artifact)

## Context

The new orchestration loop (ADR 008) asks the LLM to hold a substantially richer working context each turn than the current engine does: interview guide with per-question briefings and admin notes, coverage map across all questions, facts ledger, active threads, rapport notes, and a window of recent conversation turns. A naive concatenation puts the full context into the prompt every turn, re-sending tens of thousands of tokens of static interview-approach material on each call. That is both slow (time-to-first-token suffers) and expensive.

Anthropic's prompt cache has a 5-minute TTL and keys on exact prefix match. Anything in the prompt that does not change turn-to-turn belongs at the front so the cache hit extends as far into the prompt as possible. Anything that changes must go after. This means the prompt's structural order matters independently of what reads well for the LLM — and in practice the two orderings agree, because "stable material first, evolving material last" is also how a human consultant would read a briefing.

## Decision

The interview prompt is assembled in two tiers. **Tier 1 (static, cacheable)** contains: system persona, interview-approach doctrine (pacing, leading-question avoidance, response-handling patterns, opening/closing rituals, escalation and fallback guidance). This content comes from the versioned prompt spec (ADR 013) and changes only on a new prompt version deploy. **Tier 2 (dynamic, per-turn)** contains: interview guide with per-question briefings and admin notes, full coverage map, facts ledger, active threads, rapport notes, recent turns window, and the current interviewee utterance. Tier 2 is assembled from Redis session state each turn.

Within Tier 2, context tiering further governs how individual questions are rendered to bound total tokens. Questions in `not_started` or `partially_covered` status render with full briefing, admin notes, and sensitivity level. Questions in `fully_covered` status render as one-line status entries (`"Q7 (hardware refresh budget) — fully covered: $2.1M allocated, 18-month runway. See facts ledger entry F14."`). The `skipped` status renders similarly with a one-line reason. This keeps outstanding work fully specified while preserving enough signal from completed territory for the LLM to reference it naturally ("as we discussed around hardware...") without paying for verbose re-inclusion.

The recent-turns window is the last 8 turn pairs (16 messages). Older turns compress into the facts ledger asynchronously (ADR 012 covers the async enrichment path that produces ledger entries). The ledger is rendered as a compact list in the prompt, so the model has factual recall without carrying raw transcript tail forever. The cutoff is deliberately generous for Phase 3 — we would rather pay for a larger window early and trim later based on telemetry than under-provision and miss recall-sensitive behaviors.

## Consequences

Token spend per turn is bounded by the dynamic tier, which grows with `outstanding_questions * ~200 tokens + covered_questions * ~30 tokens + ledger + 16 messages`. For a 30-question template at the midpoint of an interview, this lands near 8-12k input tokens per turn, of which the Tier 1 ~4k is cached. Cache hit ratio is what we measure in `llm_turns` (existing event adds `cacheHitRatio` attribute — see ADR 014). First-turn cache misses are expected; we track steady-state hit ratio after turn 3.

The orchestration code needs a pure `buildPrompt(sessionState, promptVersion): { system: string, messages: Message[] }` function that takes session state and produces the two tiers. This function is the only place that knows about prompt layout; `interviewEngine.submitResponse` calls it, gets the tiers back, and hands them to the Anthropic SDK with `cache_control: { type: "ephemeral" }` on the end of Tier 1. The function is deterministic (same session + same prompt version → identical output), which makes unit testing straightforward and enables replay-based regression testing against stored session snapshots.

A meaningful constraint: prompt version changes invalidate the cache globally for all in-flight interviews. This is acceptable because prompt versions change rarely (a release cadence, not a per-interview concern), and the cache refill cost is amortized across every turn of every interview that uses the new version. ADR 013 governs when a new version is cut; the TL;DR is any change to Tier 1 doctrine is a new version.

If total prompt size grows past ~30k tokens in practice (we estimate 12k is typical, 20k is high-end), the escape valve is tighter ledger compression — we can have enrichment produce shorter summaries, or drop covered-question status lines entirely and rely on the ledger for recall. We don't prebuild that; we instrument and measure, then cut over if needed.
