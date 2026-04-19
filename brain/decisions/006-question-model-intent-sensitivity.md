# ADR 006 — Question Model: Add `intent` and `sensitivityLevel`

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes (in part):** `interview-spec-v2.md` §4 (questions table schema)

## Context

The current `Question` model (`api/prisma/schema.prisma:24-39`) has `text`, `category`, `isActive`, and tag associations. The LLM receives the question text and tags each turn and is expected to infer how to ask it, how much detail to push for, and how carefully to approach sensitive territory. This inference works reasonably for standard operational questions and fails consistently for anything that requires judgment — topics around headcount reductions, system failures, political dynamics, or vendor disputes. The design principles (`01-DESIGN-PRINCIPLES.md` §"Data Model: Questions") call out two specific fields that would fix this: `intent` (prose briefing for the AI interviewer) and `sensitivityLevel` (enum controlling approach).

## Decision

Add two nullable fields to `Question`:

- **`intent text?`** — prose briefing from the admin to the AI interviewer. Describes what information to extract, why it matters for the integration, what a good answer looks like, and which angles to explore if the conversation opens up. When null, the LLM falls back to inferring intent from `text` + tags via an explicit prompt instruction. This deliberately absorbs what a rigid schema would split into `depth_guidance`, `completion_criteria`, and `probe_hints` — one paragraph beats three structured fields because the admin writes it once, naturally.
- **`sensitivityLevel`** — enum: `standard | sensitive | highly_sensitive`. Default `standard`. Drives framing and pacing guidance in the system prompt: `standard` asks directly, `sensitive` frames carefully and backs off on resistance, `highly_sensitive` requires rapport-building first and explicit permission before probing.

Persona is **not** added as a question-level field. Questions are shared across templates; persona belongs at the template level (which template is sent to whom) and is handled by the existing `InterviewTemplate.systemPrompt` override plus the versioned prompt spec (ADR 013).

Migration is additive. No existing `Question` or `InterviewResponse` record changes; defaults preserve current behavior for every legacy row.

## Consequences

Admins gain a single coherent "Interview Guidance" section when editing a question, grouping `intent` + `sensitivityLevel` visually separate from `text` and tags. The frontend needs a large text area with helper copy explaining that `intent` briefs the AI, not the interviewee — this distinction matters for admin mental model.

The prompt template (interviewer-prompt-v1) references `intent` and `sensitivityLevel` in the interview guide formatting (per ADR 008). For questions without `intent`, the prompt emits: *"(No briefing provided; infer intent from question text and tags.)"* This keeps prompt output consistent regardless of question vintage.

Downstream we accept that `intent` content is PII-adjacent — it can contain company-specific language about what to probe for — and therefore never emitted to ClickHouse or logs. The existing `sanitizeForLog` key-based redaction handles this (keys containing `content` are already redacted), but implementers should not put `intent` under a key like `intent` in telemetry payloads; use a boolean `hasIntent` or omit the field entirely in observability events.

No change to response records. `question_text_as_asked` still captures the LLM's delivered phrasing, not the admin's intent text. The intent is a briefing to the bot, not a field the interviewee ever sees or we ever surface as provenance.
