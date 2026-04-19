# Interview Bot Transformation — Kickoff Brief

## Mission

Transform the existing interview chatbot from a rigid, deterministic question-and-answer system into an intelligent, adaptive interview orchestration engine. The bot must behave like a senior IT Integration consultant from a top-five firm (McKinsey, Accenture, Deloitte) — friendly but focused, listening deeply, probing where it matters, and never letting important details slip by unexplored.

This system conducts **post-close M&A IT integration interviews** with corporate stakeholders. Information extracted here feeds a vector database that becomes the source of truth for the entire integration project. Every detail matters. Vague answers must be challenged. Interesting threads must be pulled. Output must be richly structured for downstream ML and retrieval.

## The Core Problem

The current system treats questions as a queue: ask one, get an answer, check triggers, maybe follow up, move on. This produces robotic, surface-level interviews that miss the details a skilled consultant would catch. The transformation replaces this with a consultant-grade orchestration loop grounded in LLM judgment, backed by structured data capture and rigorous observability.

## Companion Documents

This kickoff file is the spine. Two companion files provide the details:

- **`01-DESIGN-PRINCIPLES.md`** — Orchestration model, data model changes, tag philosophy, system prompt architecture, token and context strategy, response handling patterns. Read this during Phase 2 (Design).

- **`02-OPERATIONAL-GUARDRAILS.md`** — ClickHouse observability, PII rules, documentation discipline, spec conflict handling, enforcer agent invocation, versioned prompt artifacts. Read this throughout all phases, especially Phase 1 (Discovery) and Phase 3 (Implementation).

Read all three files before beginning work. Re-read the relevant sections as you progress through phases.

## Session Startup Protocol

Before touching anything in this project, follow the existing Arena startup protocol:

1. Read `CLAUDE.md` — hard rules and spec priorities
2. Read `brain/architecture/current-state.md` — what exists right now
3. Read `brain/architecture/changelog.md` — what recently changed
4. Read relevant ADRs in `brain/decisions/` before touching any area with a decision record
5. Read `brain/specs/interview-spec-v2.md` and `brain/specs/conversation-protocol-spec-v3.md` — these are likely to be touched by this work

Only after this startup protocol is complete should you begin Phase 1 discovery.

## Phase Structure

Four phases. Explicit approval gates between Phase 1 and Phase 2, and between Phase 2 and Phase 3. Within Phase 3, work ships incrementally — each layer provides value independently.

### Phase 1: Discovery (No Code Changes)

Produce a comprehensive understanding of what exists and a proposal for what will change. Deliverable: `INTERVIEW_BOT_ANALYSIS.md` at the project root, covering:

1. **Current architecture** — components, data flow, where orchestration decisions happen
2. **Current data model** — questions, templates, tags, triggers, answers, sessions, all Redis schemas
3. **Current conversation flow** — step-by-step from session start to end
4. **Current system prompt construction** — how it's assembled, what's dynamic
5. **Current admin interface** — what works, what's clunky, especially around tag assignment
6. **What to preserve** — working functionality that must not break
7. **What must change** — gaps against the target vision
8. **Proposed approach** — your recommended implementation strategy, referencing the principles in `01-DESIGN-PRINCIPLES.md`, including deviations from the prompt's suggestions and your reasoning
9. **Proposed ClickHouse event schema additions** — detailed proposal per `02-OPERATIONAL-GUARDRAILS.md`
10. **Identified spec conflicts** — explicitly flag any conflicts with existing specs. Do not resolve silently; propose resolutions for discussion.
11. **Identified risks** — anything that concerns you about the scope, the data, the architecture, or the approach

**Stop here. Do not proceed until the analysis is reviewed and approved.** This is an explicit gate — the user will review and respond before Phase 2 begins.

### Phase 2: Design

With discovery approved, produce detailed designs for each major component. This phase can happen in one pass or iteratively, with review between iterations. Design deliverables should be saved as specs in `brain/specs/` or as ADRs in `brain/decisions/` as appropriate.

Significant design areas (details in `01-DESIGN-PRINCIPLES.md`):

- **Question data model changes** — new fields, backward compatibility, migration approach
- **Tag simplification** — flat tags, admin UI, background normalization
- **Conversation state tracking** — what's stored in Redis, what shape
- **System prompt architecture** — the consultant persona, interview approach, response handling, structured output format
- **Context/token management** — tiered question presentation, compression sidecar, just-in-time retrieval, prompt caching strategy
- **Enrichment sidecar pipeline** — what runs async, what triggers it, what it produces
- **Admin UI changes** — question fields, tag assignment, flagged items dashboard, tag normalization queue, session review
- **Observability schema** — finalized per the approval gate in Phase 1
- **Error handling and parse failure tolerance** — graceful degradation for every LLM interaction

Create a new ADR in `brain/decisions/` for each significant design decision. Create `brain/specs/interviewer-prompt-v1.md` as a new first-class spec — the system prompt is a versioned artifact in this project and deserves the same documentation discipline as code.

**Stop here. Do not proceed until the design is reviewed and approved.** This is the second explicit gate.

### Phase 3: Implementation

With designs approved, implement in layers. Each layer should be independently shippable and testable. Suggested ordering — but you are free to propose a different sequence based on what you find in the codebase:

1. Question data model changes (new fields, defaults, backward compatibility)
2. Flat tag simplification (data model + admin UI)
3. Conversation state tracking in Redis
4. New system prompt construction + orchestration loop
5. Context and token management (tiered presentation, compression, caching)
6. Async enrichment sidecar
7. Flagged items capture + admin dashboard
8. Tag normalization background job + admin review queue
9. Interview session coverage review in admin
10. ClickHouse event emission for all new event types (following Phase 1 approval)

Update `brain/architecture/current-state.md` and `brain/architecture/changelog.md` as each layer ships. Invoke the `observability-enforcer` agent whenever touching ClickHouse-adjacent code.

### Phase 4: Testing and Iteration

End-to-end validation with realistic scenarios. The bot should demonstrably:

- Probe naturally when answers are vague or shallow
- Transition topics smoothly without robotic pivots
- Reference earlier answers with new context
- Handle "I don't know" gracefully and move on
- Flag out-of-scope relevant mentions
- Open warmly and close thoroughly (summary, gaps, open invitation for additional context)
- Handle pause/resume with warm re-establishment
- Produce well-tagged, richly structured output suitable for downstream vectorization

Walk through sample interview transcripts and verify quality. Document observations. Propose iteration if needed.

## What to Ignore

- **All audio code** — ElevenLabs, audio streaming, voice synthesis, STT/ASR, audio Redis queues. This work is text-chat only.
- **AWS infrastructure changes** — keep Redis, keep the Ubuntu EC2, keep the existing service topology. All changes are in application code and data schemas.

## Working Mode

- **Backward compatible**: Existing questions, templates, and sessions must continue working. Use sensible defaults for new fields.
- **Fast path for users**: Nothing in enrichment, tagging, or compression adds latency to the live chat. Async everywhere that makes sense.
- **Creative freedom**: If you see a better approach than what's prescribed here — better data structure, cleaner orchestration, more intuitive admin flow — propose it and, if approved, implement it. Document deviations via ADR. The goal is a world-class system, not rigid adherence to this document.
- **Spec conflicts surface explicitly**: Per existing Arena convention, flag conflicts in your output. Do not resolve silently.
- **Prompts are versioned artifacts**: Treat the interviewer system prompt with the same discipline as code — versioned, documented, changelog-tracked.

## Critical Reminders

1. **Quality of captured information is paramount.** A vague answer stored as-is is a failure. It must be probed for detail or flagged as incomplete.
2. **Tag everything richly.** The vector DB downstream depends on this. Imagine someone six months from now asking "what systems does the acquired company use for financial reporting?" — will the tags and structure make that retrievable?
3. **The conversation must feel human.** If a transcript reads like a bot survey, the work has failed. If it reads like a skilled consultant having a productive conversation, the work has succeeded.
4. **Respect admin intent.** Questions, triggers (as soft guidance), required flags, templates — these are the admin's steering mechanism. The bot honors intent while exercising judgment about execution.
5. **"Required" means "bring it up," not "force an answer."** Graceful handling of unknowns and refusals. Note gaps, ask who else might know, move on.
6. **Flag unexpected discoveries.** Out-of-scope but relevant mentions are often the most valuable insights. Capture them.
7. **Observability is first-class.** Events emit as features are built, not as an afterthought. Follow PII rules strictly.
8. **Documentation updates as part of the work.** Not after. ADRs, specs, changelog entries move together with code.
