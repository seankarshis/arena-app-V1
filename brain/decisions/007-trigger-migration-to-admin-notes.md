# ADR 007 — Trigger Migration: Structured Enum → Prose Admin Notes

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes (in part):** `interview-spec-v2.md` §3 (Trigger mechanism), §4 (`followup_triggers` JSONB schema); `conversation-protocol-spec-v3.md` §5 (trigger evaluation)

## Context

The current trigger model is a structured JSONB array on `TemplateQuestion.followupTriggers` with four discriminated variants (`keyword | sentiment | length | always`) and a `targetTemplateQuestionIds` array. Admins configure them via the `TriggerEditor` modal with type-specific conditional fields. The spec says the LLM evaluates triggers; the code confirms this — no application-side keyword matching, sentiment analysis, or word counting. But the current implementation never parses the LLM's *response* for trigger decisions — it just renders triggers as prompt lines (`"- If mentions data quality → suggest follow-up {uuid}"`) and trusts the LLM to incorporate them. The structured format adds admin friction without producing structured output.

Simultaneously, design principles call for softer admin steering — prose notes on a question ("this is a critical topic — don't let vague answers slide; if they mention heavy customizations, explore contract terms") rather than rigid conditional trees. The new orchestration loop (ADR 008) also gives the LLM explicit agency to decide probe-vs-move-on; rigid triggers become redundant with the new `decisionType` output.

## Decision

Add `adminNotes text?` to `TemplateQuestion`. This field holds free-form guidance for the AI interviewer specifically for this question in this template (distinct from `Question.intent`, which is the question's master-level briefing). The interviewer-prompt-v1 spec renders `adminNotes` as "Admin notes:" lines in the interview guide, immediately after the briefing.

Deprecate `followupTriggers` through a one-release dual-read transition:

1. **Release N (Phase 3):** Add `adminNotes` column. Write a one-time migration script that formats each existing `followupTriggers` entry into prose and writes it into `adminNotes`. Format: *"If the interviewee's answer suggests [keywords / negative sentiment / is notably brief / always applies], pay extra attention to: [textual descriptions of target questions]."* `followupTriggers` JSONB is left intact; the admin UI shows it read-only with a deprecation banner.
2. **Release N+1 (Phase 4 or later):** Remove `followupTriggers` from the Prisma schema, GraphQL surface, and admin UI. Migration drops the column. The one-release lag exists so we can A/B this and roll back if the prose form underperforms.

The admin UI's `TriggerEditor` modal is replaced by a simple "Admin notes for the AI interviewer" textarea per template-question. No conditional fields, no target multi-select.

## Consequences

Admins edit soft guidance in a single text field per question per template. Writing once in prose takes less time than assembling structured triggers and produces instructions the LLM reads naturally. The `targetTemplateQuestionIds` concept goes away; if the admin wants to steer the bot toward a specific next question, they say so in prose ("if this comes up, make sure to cover Q12 on contract terms before closing out the topic"). The LLM has the full interview guide anyway and can resolve question references by topic.

Analytics that looked at `triggeredFollowups` in Redis or queried `followupTriggers` for trigger-type distributions lose their basis. Nothing currently consumes either, so nothing breaks. The new `orchestration_decisions` ClickHouse event (ADR 014) captures richer analytics (which question was probed, which was moved on from, with model confidence) that subsume what trigger-level analytics would have shown.

For existing production templates, the migration script is the only friction point. It runs once, produces reasonable prose (we do not try to be clever — literal translation is fine, admins can edit afterward), and emits an audit-log entry per template-question it modifies. Admins see a one-time "the trigger format changed; review the generated notes" nudge in the template editor.

If a downstream consumer we don't know about reads `followupTriggers`, the one-release dual-read window gives us a release cycle to catch it. If the prose form underperforms (e.g., LLM evaluation quality degrades measurably on coverage transitions), the rollback path is: stop rendering `adminNotes` in the prompt, resume rendering `followupTriggers`, restore the TriggerEditor UI. No data loss.
