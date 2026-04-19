# ADR 005 — Tag Model: Flat, Disposable, LLM-Normalized; Admin Creation Allowed Inline

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes (in part):** `interview-spec-v2.md` §3 (Tag Model), §4 (tags table schema)
**Related:** CLAUDE.md §"Data Integrity Rules" (tag creation clause refinement — see below)

## Context

Two independent issues converged here. First, `interview-spec-v2.md` specifies a `tag_type` enum on the `tags` table (`role | department | topic | seniority | domain`) and describes tags as a controlled vocabulary with administrator-only creation. The actual Prisma schema (`api/prisma/schema.prisma:10-22`) has no `tagType` column — just `label`, `isActive`, timestamps. The spec lags reality. Second, the transformation's design principles (`brain/tasks/interview-bot-transformation/01-DESIGN-PRINCIPLES.md`) call for liberal LLM-driven tagging during enrichment, which is inherently non-administrator creation. The existing CLAUDE.md rule "No freeform tag creation by non-administrators" reads as prohibiting this if taken literally.

## Decision

Tags are a flat set of `(id, label, isActive)` tuples. No hierarchy, no type column, no category. Admins create tags inline via autocomplete-with-create in the pill multi-select. Non-admin humans remain prohibited from creating tags through any UI or API path. The backend enrichment service (an authenticated system actor, not a human) may create tags as part of async enrichment; these are marked as LLM-originated via audit-log metadata for traceability. A nightly normalization job proposes synonym consolidations into the new `tag_merge_proposals` table for admin review; merges execute only on admin approval.

The CLAUDE.md rule becomes: *"Tags are a controlled vocabulary. End users cannot create tags through any interview-facing UI. Administrators may create tags inline when editing questions or templates. The enrichment service may create tags during async processing; these require admin review via the tag normalization queue."*

The spec's `tag_type` column is removed from `interview-spec-v3.md`. No database change is needed because the column was never implemented.

## Consequences

Tag proliferation is expected and welcome — more signal is better than less for downstream vectorization, and the normalization queue handles cleanup without forcing decisions at data-entry time. The admin UI's pill multi-select needs an "Add new tag" inline affordance (minor frontend change). The audit log gains a new event-type family (`tag.create.by-enrichment`) to distinguish system-originated tags from admin-originated ones; this is additive, no existing code breaks. Queries that previously assumed a typed taxonomy must be updated — none exist today, but the admin UI's tag filter should not display a "type" facet. If tag volume becomes operationally problematic (thousands of near-synonyms within weeks), the normalization job cadence can be increased; the fallback is rate-limiting LLM tag creation per enrichment run, but we do not build that guardrail preemptively.
