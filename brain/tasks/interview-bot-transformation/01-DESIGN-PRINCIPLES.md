# Design Principles — Interview Bot Transformation

This document captures the specific design decisions that inform the transformation. Read during Phase 2 (Design) and reference throughout implementation.

## Philosophy

**Prefer natural-language instructions over structured fields.** Every rigid enum, every hierarchical taxonomy, every structured schema is a constraint we impose because we don't fully trust the model. But the model, given good prose instructions, consistently outperforms our structured approximations. For every proposed field, ask: "Could this be expressed better as a sentence?" If yes, it probably should be.

**Move heavy work off the live path.** The user's chat experience must be fast. Enrichment, tagging, entity extraction, compression, cross-referencing — all of it happens asynchronously after the raw exchange is saved. The live bot produces minimal structured output; background workers do the rest.

**Trust the LLM where it's strong, constrain it where it's weak.** LLMs are good at: judgment, natural conversation, probing for detail, extracting entities, tagging subject matter, cross-referencing. LLMs are weak at: deterministic classification for downstream filtering, consistent schema adherence under pressure, parsing their own freeform output reliably. Use small controlled enums where downstream systems need reliability; use prose and free-form tagging everywhere else.

---

## The Orchestration Model

### Interview Guide, Not Script

The template's question set becomes an **interview guide** — a structured but flexible map of topics to cover. The LLM operates in a reasoning loop each turn:

1. **Assess**: What did the interviewee just say? Was it complete? Vague? Did it surface something unexpected?
2. **Evaluate Coverage**: Which questions have been fully answered? Partially answered? Not yet touched?
3. **Decide**: Probe deeper? Pivot to a related question while the topic is warm? Move to the next priority? Circle back to something mentioned earlier with new context?
4. **Act**: Formulate the next response naturally, as a consultant would.

Questions are never presented to the bot as "next in queue." They're presented as the current state of an interview guide — outstanding topics, active topics, completed topics — and the bot chooses the path.

### Opening and Closing Rituals

A consultant doesn't start with "Question 1:" and doesn't end with "that's all my questions." The bot's system prompt must explicitly instruct:

**Opening**: Introduce the purpose briefly, acknowledge the interviewee's time, set expectations about scope and length, invite questions before diving in. Build rapport before extracting information.

**Closing**: Summarize key things heard, explicitly note topics where complete information wasn't captured, ask the open-ended close: *"Is there anything we didn't cover that you think is important for the integration team to know?"* This open space is often the most valuable moment in the interview.

**Resume** (when session is picked up after a pause): Acknowledge the prior conversation warmly, briefly recap where you left off, confirm readiness to continue. Don't pick up mid-sentence.

### Avoiding Leading Questions

Explicit instruction in the system prompt: favor open-ended probes over leading ones. "Tell me more about how you handle X" rather than "I assume you're using Y?" Don't telegraph expected answers. A consultant doesn't lead the witness.

---

## Data Model: Questions

### New Fields on Questions

All new fields are optional with sensible defaults for backward compatibility.

**`intent`** (string, natural language) — The briefing for the AI interviewer. What information are we trying to extract? Why does it matter for the integration? What does a good answer look like? What angles are worth exploring if the conversation opens up? This field absorbs what a rigid schema would split into depth_guidance, completion_criteria, and probe_hints. One coherent paragraph from the admin, rich in meaning for the bot.

Example:
> *"Understand the current state of their ERP system and integration risk. We need the specific platform, version, hosting arrangement, approximate user count, and team ownership. This is a critical topic — don't let vague answers slide. If they mention heavy customizations or vendor lock-in, explore contract terms and renewal dates. If they hint at dissatisfaction, probe gently; it often surfaces integration challenges."*

Default if empty: The LLM infers intent from the question text and tags.

**`sensitivity_level`** (enum: `standard` | `sensitive` | `highly_sensitive`) — How carefully the bot should approach this question. Affects framing and opening, not just probing depth. Default: `standard`.

- `standard` — Ask directly.
- `sensitive` — Frame carefully, read the room, back off if resistance.
- `highly_sensitive` — Topics like headcount reductions, political dynamics, system failures. Approach with care, build rapport first.

### Fields to Preserve Unchanged

- `question_text`, `required`, `tags`, existing trigger configuration
- Template structure: question ordering, required flags, trigger relationships
- Question-template association (questions live independently; templates assemble them)

### "Required" Semantics

"Required" means the question should be **raised** during the interview. It does **not** force the interviewee to answer. If someone says "I don't know" or declines, the bot acknowledges gracefully, asks who else might know, notes the gap, and moves on. Never badger.

### Persona Placement

Persona is **not** a field on questions. Questions are standalone objects used across multiple templates. Persona lives at the template level (which template gets sent to whom).

---

## Data Model: Tags

### Philosophy: Disposable, Flat, LLM-Normalized

Tags are cheap identifiers attached to questions and answers. They are:

- **Flat** — no parent-child hierarchy, no categories
- **Free-form** — admins and the LLM can create new ones at will
- **Unconstrained** — duplicates, near-synonyms, and overlaps are fine
- **Normalized by background jobs, not by enforcement** — a periodic LLM-driven job proposes synonym consolidations for admin review; no auto-merging

Rationale: LLMs are genuinely good at understanding that "ERP," "NetSuite," "accounting system," and "financial platform" all relate to the same subject. Forcing a rigid taxonomy at data-entry time creates admin friction and front-loads classification decisions at a time when humans have the least context about what matters for this particular merger.

### Admin UI for Tags

- Pill-style multi-select with autocomplete against existing tags
- Inline tag creation (typing a new tag that doesn't exist creates it)
- No taxonomy view, no parent management, no "uncategorized" limbo
- Searchable, type-ahead — nudges toward reuse without enforcing it

### Backend Tag Intelligence

During enrichment, the LLM tags aggressively:
- Inherits the question's tags
- Adds entity-specific tags (system names, vendor names)
- Adds functional tags (financials, HR, infrastructure)
- Adds thematic tags (risk, dependency, quick win)
- Adds classification tags where relevant

Don't worry about duplicates or overlaps. More signal is better than less.

### Background Normalization

A periodic job (nightly or on-demand) scans recent tags, identifies clusters of near-synonyms, and proposes consolidations for admin review. Admins approve, reject, or merge. The job never auto-creates or auto-merges.

### Seeding

**Do not seed starter tags.** Seeding creates the wrong mental model (suggests a "right" set of tags). Let the tag set emerge organically from actual interview content.

---

## Data Model: Answer Enrichment (Sidecar)

**Critical: enrichment is async and must never slow the chat.** The raw answer saves immediately on the fast path. A background job produces enriched metadata.

### Fields Produced by Enrichment

**Free-form:**
- `topic_tags` — Inherited from question + liberally added by LLM

**Controlled enums (drive downstream filtering and decisions):**
- `answer_type`: `direct_response` | `follow_up_response` | `tangential_insight` | `unsolicited_detail`
- `confidence_level`: `vague` | `partial` | `specific` | `highly_detailed`
- `sentiment`: `concerned` | `confident` | `frustrated` | `uncertain` | `enthusiastic` | `neutral`
- `integration_relevance`: `critical_dependency` | `risk_factor` | `quick_win` | `long_term_consideration` | `blocker` | `informational`

**Structured data:**
- `key_entities` — system names, vendor names, team names, people, dates, numbers, technical terms
- `cross_references` — links to other answers in this session that relate
- `follow_up_needed` — boolean plus description if the answer was incomplete

### Why These Enums Stay Controlled

These four enum fields drive downstream filtering and decisions. Someone asking "show me all blockers" or "show me low-confidence answers on critical dependencies" needs deterministic filtering, not semantic search. Small controlled vocabularies with stable meaning are right for this. Everything else is free-form.

---

## Conversation State Tracking

Rich state in Redis alongside existing session data:

**`covered_questions`** — Map of question ID → status object:
- `status`: `not_started` | `partially_covered` | `fully_covered` | `skipped`
- `confidence`: `low` | `medium` | `high`
- `turn_numbers`: which turns touched this question
- `summary`: brief LLM-generated summary of what was learned

**`active_threads`** — Topics currently being discussed that span multiple questions

**`flagged_items`** — Out-of-scope but relevant mentions:
- `description`: what was mentioned
- `source_turn`: when it came up
- `suggested_tags`: LLM-generated
- `priority`: `low` | `medium` | `high` | `critical`
- `needs_admin_review`: boolean

**`conversation_summary`** — Rolling summary, maintained by compression sidecar

**`facts_ledger`** — Structured entities extracted across the session (systems, vendors, people, dates, numbers). Compact reference data the bot can access without re-reading exchanges.

**`rapport_notes`** — Interviewee's communication style, concerns, topics they seem passionate or defensive about

---

## Token and Context Strategy

### The Problem

Long interviews push context limits. A 20-question deep interview may run 60-120 turns. Without a strategy, each turn sends a bloated prompt that costs money and degrades the model's focus.

### Principles (Not Prescriptions)

Claude Code has freedom to design specifics. These are the principles to honor:

**Every token in context earns its place.** Context is attention. Irrelevant material in context degrades focus, not just cost.

**Tiered question presentation.** Outstanding questions get full briefing. The active question gets full briefing plus discussion so far. Completed questions compress to one-line status summaries. The bot's attention goes where it's needed.

**Out-of-band compression.** After each exchange, a background job produces a compressed representation for the model's future self — factual, stripped of conversational scaffolding. Raw exchanges persist in Redis for audit and vectorization; compressed versions replace them in rolling context within a few turns.

**Just-in-time retrieval.** The rolling summary handles "what was broadly discussed." When the bot needs specific detail from earlier, it retrieves that specific answer from Redis rather than keeping everything in base context. The facts ledger provides compact structured access to entities mentioned across the session.

**Prompt caching aggressively.** Static prompt sections (consultant persona, interview approach, response handling) are identical across every turn. Order them first in the prompt to enable prompt caching. Dynamic sections (coverage state, recent turns, outstanding questions) come after.

**Moderate split between live and async.** The live bot call produces: conversational response + minimal structured output (coverage updates for questions touched, flagged items if any). Async workers handle detailed enrichment, full entity extraction, sentiment analysis, comprehensive tagging. This keeps the live path fast and the output schema small.

### What's Deferred

**Asymmetric context assembly** (classifying turn intent and assembling context per-mode) is deferred as a future optimization if tokens become a problem. Don't build this initially.

---

## System Prompt Architecture

### Structure

The interviewer system prompt has stable and dynamic sections. Structure for prompt caching:

**Static (cacheable) — early in prompt:**
- Consultant persona and communication style
- Interview approach (the assess-evaluate-decide-act loop)
- Response handling patterns (vague, unknown, defensive, enthusiastic tangent, out-of-scope relevant)
- Opening and closing ritual guidance
- Leading-question avoidance guidance
- Structured output format specification

**Dynamic — later in prompt:**
- Interview context (interviewee role, template focus)
- Interview guide (formatted questions with intent and current status)
- Conversation state (coverage map, facts ledger, active threads)
- Recent conversation turns
- Rolling summary (if applicable)
- Previous session context (if resuming)

### Formatting the Interview Guide

Each question as a brief, not a form:

```
TOPIC {n}: [{tags}]
{REQUIRED or Optional} | {sensitivity if not standard}
Question: {question_text}
Briefing: {intent}
Admin notes: {trigger-based guidance reframed as soft context}
Status: {current coverage status}
```

For completed questions, compress heavily:
```
TOPIC {n}: [{tags}] — COVERED (high confidence): {one-line summary}
```

### Structured Output (Minimal)

Live bot emits conversational response plus a small structured block. Keep the schema minimal — most enrichment happens async. Suggested shape (Claude Code may refine):

```
---STATE_UPDATE---
{
  "coverage_updates": [
    { "question_id": "...", "status": "...", "confidence": "...", "summary": "..." }
  ],
  "flagged_items": [
    { "description": "...", "priority": "..." }
  ]
}
---END_STATE_UPDATE---
```

Omit keys when there's nothing to emit. No obligation to fill every field every turn.

### Tone and Style Examples

Include specific phrasings that capture the consultant voice, not just adjectives like "professional and warm." Examples to include:

- *"I want to make sure I'm understanding this correctly..."*
- *"Help me think through the implications here..."*
- *"That's a common pattern we see — how is it manifesting specifically for you?"*
- *"Let me play that back to you..."*
- *"When you say [their words], are we talking [specific example A] or more like [specific example B]?"*

A handful of examples like this will shape the bot's voice more effectively than adjectives.

---

## Response Handling Patterns

The system prompt must explicitly address these response types:

**Vague answers**: Reframe with specific angle. *"I want to make sure I capture this accurately — could you give me a specific example?"*

**"I don't know"**: Acknowledge, ask who would know, note the gap. Never push. *"No problem — who on your team would be the right person to ask about that?"*

**Overly long answers**: Extract key points and confirm. *"Let me make sure I have the important parts — it sounds like A, B, and C. Is that right?"*

**Defensive or evasive**: Back off, reframe from another angle, or return later. Never damage rapport.

**Enthusiastic tangents**: Let them run briefly (valuable signal), then redirect. *"This is great context. Before we move on, I want to capture [original topic]..."*

**Out-of-scope but relevant**: Acknowledge, probe briefly, flag for follow-up. *"That sounds important — it's outside today's scope but I want to make sure the team follows up. Can you give me a quick summary?"*

---

## Error Handling and Parse Failures

The live conversation must never break because of parsing issues. Design defensively:

**Malformed state update**: Log the parse failure as a ClickHouse event (see `02-OPERATIONAL-GUARDRAILS.md`), proceed with the conversation using last known state, optionally re-request structured output on the next turn.

**Missing state update**: Same handling. Conversation continues; missing coverage updates propagate as "stale" until the next successful update.

**Hallucinated question IDs**: Validate against known questions before applying updates. Log anomalies.

**Enrichment failure**: Retry with backoff. Flag for admin review after N retries. The raw answer remains authoritative; enrichment is additive.

**Context assembly failure**: Fall back to a minimal safe prompt. Log the failure. Never return an error to the user mid-conversation.

---

## Admin UI Changes

### Question Editing

Add new fields to the question creation/editing interface:

- **Intent** — large text area with helper text: *"Describe what information this question is trying to extract and why it matters for the integration. Include any angles worth exploring or what a complete answer looks like. This briefing guides the AI interviewer."*
- **Sensitivity** — small dropdown with brief descriptions of each level

Group these in a section called "Interview Guidance" — visually separate from the core question text and tag assignment, so admins understand these are instructions for the AI interviewer.

### Tag Assignment

Replace any hierarchical UI with a simple pill-style multi-select with autocomplete. Inline creation for new tags. No parent selection, no category management.

### Flagged Items Dashboard

New admin surface showing all `flagged_items` across sessions:
- Description, source interview, suggested tags, priority, timestamp
- Actions: dismiss, convert to a new question (pre-populated with context), assign for follow-up, add notes

### Tag Normalization Review Queue

Surface proposed tag consolidations from the background normalization job:
- Cluster of candidate synonyms, suggested canonical term
- Actions: approve merge, reject, merge differently, leave as-is

### Interview Session Review

For each completed or in-progress interview:
- Coverage map: which questions were covered, to what depth, with what confidence
- Highlight gaps: required questions skipped or got low-confidence answers
- Flagged items inline with conversation flow
- Quick access to raw transcript and structured data

### General UI Review

Review the existing admin interface holistically. The users are non-technical project managers. Prioritize clarity, efficiency, and discoverability. Document recommendations in the Phase 1 analysis before implementing in Phase 3.

---

## Creative Freedom

This document describes principles and the thinking behind them. If during discovery or design you identify a better approach — cleaner data structure, more intuitive admin flow, different orchestration mechanics — propose it. Document the deviation via ADR in `brain/decisions/`. The goal is a world-class interview system, not rigid adherence to this document.
