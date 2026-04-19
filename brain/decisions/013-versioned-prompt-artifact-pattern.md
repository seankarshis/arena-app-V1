# ADR 013 — Versioned Prompt Artifact Pattern

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR 008 (orchestration loop), ADR 010 (prompt caching), ADR 012 (enrichment prompt)

## Context

The transformation introduces at least two distinct LLM prompts that materially drive product behavior: the interviewer prompt (big, reasoning-heavy, consumed by the live turn) and the enrichment prompt (small, extraction-oriented, consumed by the Haiku sidecar). In the existing codebase, the system prompt lives as a string inside `api/src/services/promptConstructor.ts` with template overrides stored as `InterviewTemplate.systemPrompt` in the database. There is no review surface for the prompt itself; it changes when the code changes.

Prompts are product artifacts, not implementation details. They carry doctrine (how we interview, what we consider sensitive, how we handle silence) that reads more like a design document than like code. They need version history independent of the surrounding code — when we cut a new version, we want to say "v2 deployed 2026-05-10, rollback to v1 if quality regresses" with the same clarity as a feature flag. They need review by non-engineers — an admin or a domain expert should be able to read the current prompt as a document, comment on specific sentences, and propose edits. And they need tests — the same prompt, same input, should produce an output that matches a golden snapshot; deviations flag review.

None of this is served by embedding the prompt as a TypeScript string literal.

## Decision

Each product-critical prompt is a versioned specification file under `brain/specs/` with filename pattern `{prompt-name}-prompt-v{N}.md`. The first cuts are `interviewer-prompt-v1.md` (Phase 2 deliverable, companion to this ADR) and `enrichment-prompt-v1.md` (Phase 3 deliverable). The spec contains: purpose statement, output-format contract (what the model must emit and in what shape), the full prompt content broken into labeled sections, and a worked example (filled-in input → expected output) at the end.

At build time, the spec is read and parsed into its structural sections, which become the inputs to the prompt-construction code (`buildPrompt` from ADR 010). The parsing is deliberately simple — labeled sections by markdown heading — so that the spec file remains human-readable and diffable. The version number is baked into every emitted prompt and recorded on every `llm_turns` / `enrichment_jobs` event as `promptVersion`, so we can correlate model behavior with prompt version in analytics.

New versions are cut explicitly, not silently. Any change to Tier 1 content (persona, approach, response-handling patterns) that affects live orchestration requires incrementing the major version: `interviewer-prompt-v2.md` is a new file, and the old `v1.md` stays in the repo as an archive. `InterviewTemplate.systemPrompt` remains as a per-template override mechanism — it layers on top of the versioned base, appended to Tier 1 after the base doctrine, for template-specific framing. Template overrides are not versioned the same way; they live in the database and change per template's edit history, which is captured by the audit log.

## Consequences

Admins gain visibility and a review surface. The interviewer prompt is readable as a single document, diffs show up in PR review, and comments on specific lines work the same way they do for any other spec file. Non-engineer domain experts can propose edits via PR comments or directly via the admin UI's template override field (for template-specific adjustments), without touching code. The prompt gets treated with the same rigor as a schema change.

The code change to support this pattern is small. One loader function reads and parses a spec file; `buildPrompt` calls it with a version string and composes Tier 1 from the parsed sections. For test stability, the loader reads the file at startup, caches the parsed form in memory, and exposes the current version on a health endpoint. Hot-reloading is not required — a prompt version change ships as a normal deploy.

A tradeoff: spec files and code diverge in review cadence. A PR that touches only the interviewer prompt looks like a spec edit, not a code change, and may get less scrutiny from engineers who skip spec PRs. We compensate by requiring that any prompt version bump be reviewed by at least one engineer and one product/domain reviewer (enforced via CODEOWNERS on `brain/specs/*-prompt-v*.md`). The enforcement is a process norm, not a technical constraint, but it is the right one.

For rollback: if a new prompt version regresses quality in production, rollback is to change the version string the runtime loads — no data migration needed. Prior versions are still in the repo, still parseable, still valid. The `promptVersion` attribute on telemetry makes the before/after comparison straightforward in ClickHouse.

If we ever need live A/B testing between prompt versions, the pattern extends cleanly: `buildPrompt(session, promptVersion)` already takes the version as a parameter, and the version can be chosen per-session by a feature flag. That work is Phase 4 if it becomes a priority; we don't build it now.
