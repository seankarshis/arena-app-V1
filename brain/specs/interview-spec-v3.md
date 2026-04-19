# Interview Spec — v3 (Data Model + Admin UI Bump)

**Status:** Active
**Supersedes:** `interview-spec-v2.md` (sections called out below). All other sections of v2 remain authoritative.
**Date:** 2026-04-18
**Related ADRs:** 005 (tag model), 006 (question additions), 007 (trigger migration), 008 (orchestration loop), 013 (prompt artifact), 014 (ClickHouse events)

---

## How to read this spec

This is a **diff-style supersede**. Each section below names a section of `interview-spec-v2.md` and states what changes. Sections of v2 not listed here are unchanged and still authoritative. When v3 and v2 conflict, v3 wins. When v3 is silent, v2 is the source of truth.

---

## Changes

### §3 (Architecture Decisions) — Tag System with Controlled Vocabulary — REPLACED

**Replaces:** v2 §3 "Tag System with Controlled Vocabulary."

Tags are a flat set of `(id, label, isActive)` tuples. No `tag_type`. No hierarchy. No category column. Tag creation rules:

- **End users (interviewees) cannot create tags** through any interview-facing UI or API path.
- **Administrators may create tags inline** when editing questions or templates, via an autocomplete-with-create pill multi-select.
- **The backend enrichment service (arena-enrichment) may create tags** during async processing. Enrichment-created tags are flagged via audit log (`tag.create.by-enrichment`) and surfaced to admins in the tag normalization review queue.
- A nightly normalization job proposes synonym consolidations into a new `tag_merge_proposals` table. Merges execute only on admin approval.

Rationale: see ADR 005.

### §3 (Architecture Decisions) — Follow-Up Trigger Evaluation and Nudging — REPLACED

**Replaces:** v2 §3 "Follow-Up Trigger Evaluation," "Follow-Up Nudging via Triggers," and "Orphaned Follow-Up Trigger Handling."

The structured `followupTriggers` JSONB field on `TemplateQuestion` is deprecated. Admin intent is captured instead as prose in `TemplateQuestion.adminNotes`. The prompt renders `adminNotes` as natural-language guidance for the AI interviewer. The LLM, now under an explicit orchestration contract (ADR 008), makes probe-vs-move-on decisions via its state-update block rather than via trigger rule evaluation.

Transition: dual-read for one release (see ADR 007 for full rollout plan). Existing structured triggers are migrated to prose by a one-time script; the JSONB column is dropped one release later.

Rationale: see ADR 007.

### §4 (Data Model) — `tags` table — REPLACED

**Replaces:** v2 §4 `tags` table definition.

```
tags
  id              uuid primary key
  label           varchar not null unique
  is_active       boolean not null default true
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
```

**Removed:** `tag_type` column (was never implemented in Prisma; v2 was aspirational and code is authoritative). No migration needed.

### §4 (Data Model) — `questions` table — EXTENDED

**Additive to** v2 §4 `questions` table. Existing columns unchanged.

Add:
```
intent              text nullable
sensitivity_level   text not null default 'standard'
                    check (sensitivity_level in ('standard','sensitive','highly_sensitive'))
```

`intent` is prose briefing from the admin to the AI interviewer — describes what information to extract, why it matters, what a good answer looks like, which angles to explore. When null, the prompt emits a fallback instructing the LLM to infer intent from question text and tags.

`sensitivityLevel` drives prompt framing: `standard` asks directly; `sensitive` frames carefully and backs off on resistance; `highly_sensitive` requires rapport-building and explicit permission before probing.

Migration is additive. Existing rows receive `intent = null` and `sensitivity_level = 'standard'`; current behavior is preserved.

Rationale: see ADR 006.

### §4 (Data Model) — `template_questions` table — EXTENDED

**Additive to** v2 §4 `template_questions` table.

Add:
```
admin_notes     text nullable
```

Deprecate (one-release window): `followup_triggers` JSONB column remains in place, read-only from the admin UI, for one release. Removed in the subsequent release.

Rationale: see ADR 007.

### §4 (Data Model) — new table `tag_merge_proposals` — NEW

```
tag_merge_proposals
  id                  uuid primary key
  canonical_tag_id    uuid not null references tags(id)
  candidate_tag_ids   uuid[] not null
  rationale           text nullable
  status              text not null default 'pending'
                      check (status in ('pending','approved','rejected','merged'))
  proposed_at         timestamptz not null default now()
  reviewed_by         uuid nullable references users(id)
  reviewed_at         timestamptz nullable
  created_at          timestamptz not null default now()
  updated_at          timestamptz not null default now()
```

Populated by the nightly tag normalization job; consumed by the admin tag review queue.

### §4 (Data Model) — new table `flagged_items` — NEW

Backs the new orchestration-flagged-item feature (LLM emits `flaggedItems` in its state update; backend persists each to this table).

```
flagged_items
  id                       uuid primary key
  interview_id             uuid not null references interviews(id)
  source_turn              int not null
  description              text not null
  suggested_tags           jsonb not null default '[]'
  priority                 text not null
                           check (priority in ('low','medium','high','critical'))
  needs_admin_review       boolean not null default true
  dismissed_at             timestamptz nullable
  converted_to_question_id uuid nullable references questions(id)
  created_at               timestamptz not null default now()
  updated_at               timestamptz not null default now()
```

### §4 (Data Model) — new table `enrichment_outbox` — NEW

Implements the transactional outbox pattern for async enrichment (ADR 011, ADR 012).

```
enrichment_outbox
  id              uuid primary key
  response_id     uuid not null references interview_responses(id)
  interview_id    uuid not null references interviews(id)
  dispatched_at   timestamptz nullable
  attempt_count   int not null default 0
  created_at      timestamptz not null default now()
```

Row inserted in the same transaction as the `interview_responses` write on each turn. A dispatcher (embedded in the Fastify process in Phase 3) polls `dispatched_at IS NULL` rows, publishes to SQS, stamps `dispatched_at`.

### §5 (Observability) — ClickHouse Event Types — EXTENDED

Five new `event_type` values join `arena_telemetry`. Full schemas in ADR 014 and in `brain/tasks/interview-bot-transformation/INTERVIEW_BOT_ANALYSIS.md` §9 (approved).

- `orchestration_decisions`
- `coverage_transitions`
- `enrichment_jobs`
- `flagged_items`
- `state_parse_failures`

A new service registers: `arena-enrichment`. The observability-enforcer config (`.claude/agents/observability-enforcer.md` §"Registered Service Names" and §"Registered Event Types") updates atomically with the first emitting code.

### §9 (LLM Interview Orchestration) — REPLACED

**Replaces:** v2 §9 in full. Orchestration mechanics now defer to:
- ADR 008 (orchestration loop replaces deterministic queue).
- ADR 009 (structured output via text delimiters).
- ADR 010 (context tiering + prompt caching layout).
- `brain/specs/interviewer-prompt-v1.md` (the Tier 1 prompt content).
- `brain/specs/conversation-protocol-spec-v4.md` (runtime turn lifecycle).

Short version: the engine no longer selects questions via `getNextQuestion(session) = requiredRemaining[0] ?? optionalRemaining[0]`. It hands the LLM the full interview guide plus coverage state and recent turns, and parses the LLM's state-update block to apply coverage transitions, flagged items, and the orchestration decision. Completion is signaled by `decisionType: 'close_interview'` in combination with coverage gates (all required questions `fully_covered` with confidence ≥ `medium`, or `skipped` with acknowledgement).

### §10 (Admin Interface) — Question Management Interface — EXTENDED

**Additive to** v2 §10 "Question Management Interface."

Add an "Interview Guidance" section to the question editor, grouping:
- `intent` as a large text area with helper copy: *"Describe what information this question is trying to extract and why it matters for the integration. Include any angles worth exploring or what a complete answer looks like. This briefing guides the AI interviewer, not the interviewee."*
- `sensitivityLevel` as a small dropdown (`standard | sensitive | highly_sensitive`) with a one-line descriptor next to each option.

Visually separate this section from the core question text and tag assignment. Admins must understand these fields brief the AI, not the interviewee.

### §10 (Admin Interface) — Tag Management Interface — REPLACED

**Replaces:** v2 §10 "Tag Management Interface" where it described a typed taxonomy.

Tag management is a flat list view with inline edit, deactivate, and a new tag normalization queue tab that surfaces `tag_merge_proposals` for review. Remove any type-facet filter. Inline tag creation is permitted for admins in question and template editors (autocomplete with create).

### §10 (Admin Interface) — Template Management Workflow — EXTENDED

**Additive to** v2 §10.

Per-template-question `adminNotes` replaces the `TriggerEditor` modal. The admin sees a simple "Admin notes for the AI interviewer" textarea per question inside the template editor. No conditional fields, no target multi-select. During the deprecation window, existing `followupTriggers` render read-only with a "deprecated — migrate by editing adminNotes" banner.

### §10 (Admin Interface) — new: Flagged Items Dashboard — NEW

New admin surface showing all `flagged_items` across sessions. Columns: description, source interview, suggested tags, priority, timestamp. Actions: dismiss, convert to a new question (pre-populated with context from the flagged item), add notes.

### §10 (Admin Interface) — new: Interview Session Review — NEW

Per-interview admin view. Shows:
- Coverage map: which questions were covered, to what depth, with what confidence (from the final coverage state in Redis / persisted snapshot).
- Highlighted gaps: required questions that were `skipped` or ended at `partially_covered` + `low` confidence.
- Flagged items inline at the turn where they were raised.
- Raw transcript and structured data side-by-side.

Admins can disagree with the bot's coverage-confidence calls and mark questions `partially_covered` manually — this is the corrective feedback loop called out in ADR 008.

### §19 (Constraints and Guardrails) — Tag Creation Rule — REFINED

**Replaces:** v2 §19 rule regarding "No freeform tag creation by non-administrators."

New wording (also applied to `CLAUDE.md`):
> Tags are a controlled vocabulary. End users cannot create tags through any interview-facing UI. Administrators may create tags inline when editing questions or templates. The enrichment service may create tags during async processing; these require admin review via the tag normalization queue.

---

## What did NOT change

These v2 sections remain authoritative and are not superseded:

- §1 System Overview, §2 Technology Stack, §3 Architecture Decisions *except* tag system and trigger evaluation, §4 all tables except those explicitly called out above, §5 Observability *except* new events added above, §6 Authentication, §7 ElevenLabs contract, §8 GraphQL schema (the new types for `flaggedItems`, `adminNotes`, `intent`, `sensitivityLevel`, `tagMergeProposals` are additive and follow v2's existing conventions — implementation-level detail left to the resolver work), §11 Cleaning pipeline, §12 Reconciliation, §13 AWS service mapping, §14 Local dev, §15 Testing strategy, §17 Operational guidance, §20 Consent and retention.

§16 Implementation Priority is obsolete as guidance for the current transformation; the new Phase 3 layer ordering in `brain/tasks/interview-bot-transformation/00-KICKOFF.md` and `brain/tasks/interview-bot-transformation/INTERVIEW_BOT_ANALYSIS.md` §8 governs what ships when.

§18 Open Questions no longer tracks current work; `brain/tasks/interview-bot-transformation/` is authoritative for in-flight decisions.
