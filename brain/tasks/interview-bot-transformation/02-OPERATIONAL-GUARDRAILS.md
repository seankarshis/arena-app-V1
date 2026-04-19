# Operational Guardrails — Interview Bot Transformation

This document covers the discipline that keeps the system observable, documented, and maintainable. Read during Phase 1 (Discovery) before proposing schemas. Reference throughout Phase 3 (Implementation).

## ClickHouse Observability

### Use Existing Infrastructure

The project uses a single-table observability pattern via `arena_telemetry`. All writes go through `api/src/observability/clickhouseWriter.ts`. Schema bootstrap happens at server startup. PII sanitization is enforced in two places: `sanitize.ts` for payload keys, and the `PiiScrubbingSpanProcessor` for OTel spans.

**Do not invent new tables.** All new events go into `arena_telemetry` following the existing column schema:
- `install_id`, `timestamp`, `environment`, `service_name`, `event_type`, `severity`, `trace_id`, `span_id`, `attributes` (JSON)

**Follow existing conventions:**
- `event_type`: snake_case
- Attribute keys inside the JSON payload: camelCase
- Severity: INFO by default; ERROR when error rate exceeds thresholds or critical alerts exist

### Proposed New Event Types (Pending Approval)

These event types need to be proposed as part of the Phase 1 discovery deliverable and **explicitly approved by the user before any emitting code is written.** This is a gate, not a suggestion.

**`orchestration_decisions`** — Captures the bot's judgment moments.
- When: bot decides to probe deeper vs move on; topic transitions; follow-up vs pivot choices
- Suggested attributes: turnNumber, currentQuestionId, decisionType (`probe_deeper` | `move_on` | `transition_topic` | `flag_item` | `circle_back`), confidenceScore, sessionId (pseudonymized)
- Value: this is the data that answers "why did the bot do what it did?" six months from now

**`coverage_transitions`** — Captures interview trajectory.
- When: any question's coverage status changes
- Suggested attributes: questionId, oldStatus, newStatus, oldConfidence, newConfidence, turnNumber, sessionId (pseudonymized)
- Value: trajectory analysis, training signal, identifying questions that consistently get low confidence

**`enrichment_jobs`** — Captures async enrichment lifecycle.
- When: enrichment starts, succeeds, fails, retries
- Suggested attributes: jobType, durationMs, status (`started` | `succeeded` | `failed` | `retried`), retryCount, answerId (pseudonymized), errorCode (on failure)
- Value: catches silent enrichment failures; enrichment isn't visible to users but is critical to the data pipeline

**`flagged_items`** — Captures out-of-scope discoveries.
- When: bot flags a mention as important but outside question set
- Suggested attributes: priority (`low` | `medium` | `high` | `critical`), sourceTurn, suggestedTagCount (count, not tag values — see PII rules), sessionId (pseudonymized)
- Value: surfaces what's being learned outside the planned question set; critical for continuously improving the question library

**`state_parse_failures`** — Captures structured output issues.
- When: LLM's state update block is malformed or missing
- Suggested attributes: turnNumber, parseErrorType (`missing_block` | `invalid_json` | `schema_mismatch` | `unknown_question_id`), sessionId (pseudonymized)
- Value: low-frequency hopefully, but catastrophic if silent; monitors the reliability of the bot's structured output

### PII Compliance — Non-Negotiable

**Forbidden in ClickHouse:** Names, emails, transcription content, question text, audit log diffs, auth tokens, IP addresses, any raw interviewee language.

**Allowed in ClickHouse:** UUIDs (pseudonymized via HMAC-SHA256 with salt), error codes, stack traces, token counts, latency metrics, model names, counts (including counts of tags, entities, items), timestamps, enum status values.

**Fuzzy middle zone — apply extra caution:** Bot-generated summaries may contain fragments of interviewee language. Coverage summaries stored in Redis should not be emitted as ClickHouse attributes. Emit *about* the summary (it exists, it has a certain length, a coverage status changed) but not the summary itself.

**When designing an event's attributes, always ask:** "Does this attribute contain anything the interviewee said, anything they were asked, or anything that identifies them personally?" If yes or maybe, exclude it or pseudonymize it.

### Enforcer Agent

The project has a specialized `observability-enforcer` agent defined in `.claude/agents/observability-enforcer.md` with an 11-point review checklist.

**Invoke this agent:**
- After proposing the new event schemas in Phase 1 (optional but recommended — can catch issues before the approval gate)
- Before shipping any code that writes to ClickHouse
- Whenever PII boundaries are ambiguous

The existing project instructions call for proactive invocation of this agent whenever new code touches logging. Honor that convention.

### Write Mechanism

All new events go through the existing `clickHouseWrite()` function:

```typescript
clickHouseWrite(eventType, payload, { severity?, serviceName? })
```

Fire-and-forget. Never blocks caller. Errors never propagate. Silently no-ops if observability env vars are unset. Do not invent new write mechanisms.

---

## Documentation Discipline

### Existing Documentation Structure

This project has a mature documentation system. Use it. Do not create parallel structures.

| What | Where | When to update |
|---|---|---|
| Agent rules & constraints | `CLAUDE.md` | When new patterns emerge from this work |
| Module status snapshot | `brain/architecture/current-state.md` | When features ship or gaps close |
| Change log | `brain/architecture/changelog.md` | Alongside current-state updates |
| Technical decisions | `brain/decisions/001–NNN.md` | Every significant decision |
| Data model & schema | `brain/specs/interview-spec-v2.md` | When data model changes; wins on data model conflicts |
| Runtime behavior | `brain/specs/conversation-protocol-spec-v3.md` | When runtime behavior changes; wins on frontend/runtime conflicts |
| Runbooks | `brain/runbooks/` | When operational procedures change |
| Active/backlog tasks | `brain/tasks/` | As tasks are defined and completed |

### Session Startup (Mandatory)

Before any work:
1. `CLAUDE.md` — hard rules and spec priorities
2. `brain/architecture/current-state.md` — what exists right now
3. `brain/architecture/changelog.md` — what recently changed
4. Relevant ADRs in `brain/decisions/` — before touching any area with a decision record
5. `brain/specs/interview-spec-v2.md` and `brain/specs/conversation-protocol-spec-v3.md` — likely to be affected by this work

### ADRs: One per Significant Decision

Create a new numbered file in `brain/decisions/` for each significant architectural choice made during this work. Format:
- **Context** — what problem or situation prompted the decision
- **Decision** — what was decided
- **Consequences** — what this enables, what it commits us to, what it closes off

Keep ADRs lightweight — three paragraphs each is typical. This is a decision log, not an essay.

Decisions that warrant an ADR in this work likely include:
- Tag flattening (removing hierarchy)
- Sidecar enrichment pattern
- Context tiering strategy
- Structured output format for live bot
- New ClickHouse event schemas (after approval)
- Moderate split between live and async
- System prompt versioning approach

**When deviating from the principles in `01-DESIGN-PRINCIPLES.md`**, write an ADR explaining the deviation. The principles document is guidance, not law — but deviations deserve explicit reasoning.

### Versioned Prompt Artifacts (New Pattern)

The interviewer system prompt is a first-class artifact of this project. Establish `brain/specs/interviewer-prompt-v1.md` as its home. Treat it with the same discipline as code:

- Changes to the prompt go through the changelog
- Significant changes warrant an ADR explaining the reasoning
- Version numbers are bumped (v1, v2) for substantial revisions, not minor tweaks
- The live prompt in code should be generated from or reference the spec, not diverge from it

This is a new pattern being established by this work. If it proves useful, extend it to other prompts in the system over time. Add a brief note to `CLAUDE.md` explaining the pattern once it's in use.

### Inline Documentation: Comment the Why

Code comments in this work should explain *why*, not *what*. The code already shows what it does. Document:

- The context assembly logic — why completed questions are compressed, why the guide isn't sent in full
- The prompt template structure — why the ordering enables prompt caching, why specific phrasings were chosen
- The enrichment pipeline contracts — what the live bot produces, what async adds, what happens on failure
- Parsing and error handling — why certain failures are tolerated, what the fallback behavior is
- State transitions — lifecycle of coverage status, sessions, flagged items

Future maintainers — including future Claude Code sessions — should be able to understand the rationale without reconstructing it from scratch. Don't narrate mechanical operations; explain non-obvious choices.

### Architecture Documentation

Update `brain/architecture/current-state.md` as each implementation layer ships. Add corresponding entries to `brain/architecture/changelog.md` explaining what changed and why.

Consider whether this work warrants a dedicated component README in `brain/architecture/` for the interview orchestration engine specifically — covering the live bot, enrichment pipeline, compression service, and their contracts. If yes, create it.

### Spec Conflicts

The existing `interview-spec-v2.md` and `conversation-protocol-spec-v3.md` are authoritative today. This work will likely conflict with them.

**Per existing Arena convention: flag conflicts explicitly in output. Do not resolve silently.**

In Phase 1 discovery, enumerate identified conflicts. Propose resolutions for discussion. After approval, update the specs (potentially as v3 / v4) and create ADRs documenting the resolution.

---

## Task Documentation

Consider creating a task file in `brain/tasks/` for this work. A feature-scoped task spec keeps the scope visible and trackable. Use it for:

- High-level objectives (reference to the kickoff)
- Phase tracking (Phase 1 in progress, Phase 2 pending approval, etc.)
- Cross-references to ADRs created during the work
- Cross-references to spec updates
- Risk log

This is optional but recommended for a multi-phase effort like this one.

---

## Summary of Guardrails

- ClickHouse: single table, existing patterns, new event types require explicit approval, strict PII compliance, enforcer agent invoked proactively
- Documentation: follow existing Arena conventions, ADRs for significant decisions, spec conflicts flagged not resolved silently, versioned prompt artifact as new pattern
- Inline comments: why, not what
- Changelog and current-state updates alongside work, not after
- Task file in `brain/tasks/` to track multi-phase progress
