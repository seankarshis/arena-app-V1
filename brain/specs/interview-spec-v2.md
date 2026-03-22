# Interview Platform Technical Specification (v2)

## Document Purpose

This is the authoritative technical specification for building the Arena interview platform — the first product of Elastic Horizon. It is intended to be consumed by Claude Code in planning mode. All decisions documented here have been deliberated and settled. Follow them as stated unless a specific override is provided during implementation.

This document covers: data model, technology stack, infrastructure, GraphQL API, admin interface, post-interview pipeline, observability, authentication, local development, and testing. For the runtime conversation protocol (how the interview session actually works at runtime — message sequences, audio architecture, frontend state machine, pause/resume, inactivity handling, error recovery, and UI layout), see `conversation-protocol-spec-v3.md`. That document is an equal-authority companion to this one.

### Naming Conventions

- **Elastic Horizon**: The company and brand. Used in UI copyright notices, legal references, and public-facing content.
- **Arena**: The internal platform codename. Used in code, repo names (`arena-app`), internal documentation, and infrastructure resource naming.
- **Brand standards**: Defined in `brandStandards.md`. All UI work must follow these standards.


---

## 1. System Overview

### What We're Building

An interview platform where an LLM conducts structured interviews with users. Administrators define interview templates containing curated, ordered question sets with follow-up logic. Users are assigned templates. The LLM conducts natural conversations while maintaining research validity through consistent question sets across interviewees. The platform captures audio responses, transcribes them in real-time via live speech-to-text streaming, cleans the transcriptions into structured markdown using an LLM, and stores everything with full auditability.

Users interact via a dual-mode interface: they can type responses or use push-to-talk voice input. The LLM replies appear as streaming text and synthesized audio. The complete runtime conversation protocol is defined in `conversation-protocol-spec-v3.md`.

### Core Design Principles

- **Research validity**: Consistent question sets across users assigned the same template, enabling meaningful comparison of responses
- **Conversational naturalness**: The LLM has discretion to reorder, adapt, and follow up naturally within the bounds of the template
- **Full auditability**: Every question asked and every answer given is snapshotted at the time of the interview, independent of future edits to master data. All administrative actions are logged. When the LLM adapts or rephrases a question, the exact text delivered to the user is captured — not the original template text.
- **Administrative control**: Curators have full control over question sets, ordering, categorization, and follow-up logic
- **Single data store simplicity**: One database, one transaction boundary, one query language
- **Observable by default**: All errors, traces, and metrics flow to ClickHouse Cloud via OpenTelemetry. Critical conditions trigger alerts. No PII in telemetry.
- **Privacy and consent**: All data collection — especially voice audio — requires informed, recorded consent. Users have rights to access and request deletion of their data. See Section 20: Data Privacy, Consent, and Retention.
- **Cost visibility**: Every LLM call, STT session, and TTS generation is metered at the response level, enabling per-interview and per-user cost tracking.

### UI Considerations and Brand Standards

See `brandStandards.md` for colors, typography, component patterns, and imagery guidelines. The interview session UI layout is specified in conversation-protocol-spec-v3.md Section 13.

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript | Type safety across the full stack; catches schema mismatches at compile time during fast iteration |
| Backend framework | **Fastify** | Better WebSocket support than Express, built-in schema validation, better performance under concurrent I/O, plugin architecture maps well to service boundaries |
| GraphQL | Apollo Server | Most mature GraphQL server; built-in DataLoader, subscriptions, plugin architecture. Runs as Fastify plugin via `@as-integrations/fastify`. |
| ORM | Prisma | Type-safe queries generated from declarative schema; clean migrations; strong relation support matching our data model |
| Database | PostgreSQL on RDS | Single relational store for all structured data, transcription text, and cleaned markdown; TOAST storage handles large text fields efficiently; full-text search via tsvector/tsquery; pgvector extension available for future semantic search |
| Frontend | Next.js + React | SSR, API routes, component ecosystem for admin UI; single codebase serves both admin and interviewee experiences via route-based separation |
| Frontend hosting | ECS Fargate | Next.js in Docker, same ECS cluster as API server, behind shared ALB; keeps entire stack within AWS |
| UI components | shadcn/ui | Accessible, composable, customizable. Built on Radix primitives. |
| Audio capture | MediaRecorder API | Client-side per-response recording via push-to-talk; audio Blobs uploaded progressively to S3. See conversation-protocol-spec-v3.md Section 2. |
| Object storage | S3 | Per-response audio segment storage with lifecycle policies per prefix |
| Live STT | ElevenLabs (via Fargate) | Real-time speech-to-text during interviews; Fargate API proxies authenticated WebSocket connection between client and ElevenLabs STT API |
| TTS | ElevenLabs (via frontend) | Text-to-speech for LLM responses; frontend calls ElevenLabs TTS API directly with sentence-level chunks for low-latency playback |
| Queue | SQS | Decouples post-interview pipeline steps |
| Event orchestration | EventBridge | Interview completion triggers, pipeline step transitions, scheduled reconciliation |
| Cache / session | ElastiCache Redis | Ephemeral interview session state and in-progress transcript assembly during active interviews |
| Auth | Amazon Cognito | Managed user pool, admin-invite-only, email/password, JWT validation at API layer |
| Serverless compute | Lambda (Node.js 20) | Post-interview cleaning pipeline, user sync trigger, reconciliation jobs |
| Observability | **ClickHouse Cloud** via **OpenTelemetry SDK** | All traces, metrics, and structured logs. Single observability backend. |
| Testing | **Vitest** | Fast, native ESM/TypeScript support, compatible with the full stack |
| Deployment | ECS Fargate (all services) | API server and frontend in same ECS cluster behind shared ALB with path-based routing |

### Stack Notes

- The entire application is I/O-bound (database queries, S3 operations, LLM API calls, STT streaming). Node's event loop handles concurrent I/O naturally, which matters when multiple interview sessions are active simultaneously.
- Prisma generates TypeScript types from the database schema. GraphQL resolvers, database queries, and application logic all share the same type definitions. The compiler catches data model / API mismatches immediately.
- Apollo Server's DataLoader integration prevents N+1 query problems across our heavily relational data model.
- The Fargate API server handles WebSocket connections for live STT streaming. During an interview, the client streams audio chunks over an authenticated WebSocket to the Fargate service, which proxies them to ElevenLabs' real-time STT API. Transcription results stream back through the same connection to the UI for real-time display. WebSocket authentication is specified in conversation-protocol-spec-v3.md Section 12.

---

## 3. Architecture Decisions

### Audio Handling: Per-Response Segments via Push-to-Talk

**This section is a summary. The authoritative audio architecture is in conversation-protocol-spec-v3.md Section 2.**

The push-to-talk interaction model naturally creates discrete, per-response audio segments. Each PTT press starts a recording; each release ends it. Audio segments upload to S3 progressively in the background during the interview, not as a batch after completion. Text-only responses have no audio. Draft audio (from redo attempts) is also uploaded for STT debugging.

There is no monolithic post-interview audio upload. The v1 spec's "Post-Interview Audio Upload" section is fully superseded.

### Template-Driven Interview Structure

Interviews are driven by administrator-curated templates. Administrators define the question set, ordering, category bucketing, required/optional flags, and follow-up triggers. The LLM works from this bounded, pre-curated set rather than reasoning over the entire question bank. This ensures consistent question sets across users assigned the same template, enabling valid comparison of responses. It requires more administrative setup, but that tradeoff is accepted.

### Snapshot-Based Response Storage

When a question is asked during an interview, the exact text delivered by the LLM to the user is captured into the response record as a point-in-time snapshot. The LLM has discretion to adapt and rephrase questions conversationally; the `question_text_as_asked` field records the LLM's actual output — not the original template text. The response record is self-contained: you can open it and see exactly what was asked and what was answered. Administrators can deactivate or edit master questions without impacting any past interview data.

**LLM output capture mechanism:** During each turn, the backend streams the LLM completion to the client via SSE. As it streams, the backend accumulates the full LLM completion text in the Redis session under a `current_turn_llm_text` field. When the SSE stream closes (all tokens received), this cached text becomes the authoritative `question_text_as_asked` value for the subsequent `submitResponse` call. This ensures that if the LLM rephrases, paraphrases, or contextualizes a template question, the snapshot reflects what the user actually saw — not the original template wording. See also Section 9 (Per-Turn State Update) and the Parameter Ownership table in Section 8.

### Tag System with Controlled Vocabulary

Tags are master records maintained by administrators via a controlled vocabulary interface (dropdown selection, not freeform text). Tags have types (role, department, topic, seniority, domain) to enable differentiated filtering and analytics. Tags live on both questions and users. Flat hierarchy for v1 with no parent-child tag relationships. Tags are never hard-deleted — they are deactivated via `is_active` flag.

### Soft-Delete Policy

Tags, questions, and templates are **never hard-deleted** from the database under normal operation. This ensures historical records remain intact. (For data subject deletion requests, see Section 20: Data Privacy, Consent, and Retention.)

- **Tags**: Deactivated via `is_active = false`. Removed from selection dropdowns but existing associations remain.
- **Questions**: Deactivated via `is_active = false`. Removed from the question bank for new templates but remain in existing templates.
- **Templates**: Archived via `status = 'archived'`. Retired but preserved for historical reference.

No `deleteTag`, `deleteQuestion`, or `deleteTemplate` mutations exist. Claude Code must not create them.

### Follow-Up Trigger Evaluation

**The LLM evaluates all follow-up triggers.** There are no application-side keyword matchers, sentiment analysis services, or word count functions. Trigger definitions from the template are passed directly into the LLM system prompt, and the LLM uses its judgment to determine whether triggers have been activated. This is simpler, more contextually appropriate, and consistent with the overall design that trusts the LLM with significant discretion. See conversation-protocol-spec-v3.md Section 6 for the full specification.

### Follow-Up Nudging via Triggers

Questions within a template can have follow-up triggers that nudge the LLM to ask specific follow-up questions based on response characteristics.

Supported trigger types:
- **keyword**: Response discusses specific topics or concepts (LLM judges semantic match, not exact string matching)
- **sentiment**: Response has positive, negative, or neutral sentiment (LLM judges)
- **length**: Response is notably brief or extensive (LLM judges, no exact word count)
- **always**: Follow-up is always suggested after this question regardless of response content

Follow-ups are suggestions to the LLM, not hard redirects. The LLM maintains conversational discretion.

### Orphaned Follow-Up Trigger Handling

When removing a question from a template, if that question's ID appears in any other question's `suggested_followup_question_ids`, the admin receives a warning: "This question is referenced as a follow-up target by [question X]. Please update or remove that follow-up trigger before removing this question." The removal is blocked until the trigger reference is resolved.

As a safety net, the LLM system prompt includes the instruction: "If a trigger references a follow-up question that is not in your current question set, skip that trigger."

### Cleaning Pipeline Trigger

Interview completion fires an EventBridge event (`interview.completed`). This is the **sole trigger** for the cleaning pipeline. There is no S3-based trigger. The cleaning pipeline processes `raw_transcription` text, not audio files.

### User-to-Template Assignment (Many-to-Many)

Users can be assigned multiple templates simultaneously via the `user_templates` junction table. This supports business scenarios where a single user participates in multiple distinct interview streams (e.g., IT Audit, HR Integration, and Financial Reporting during an M&A integration). Each assignment is tracked independently with its own status and audit trail.

When a user logs in, the frontend queries their active template assignments and presents a list of pending/available interviews. The user selects which interview to start.

**Reassignment blocking rule:** A specific user–template assignment cannot be removed or modified while the user has an interview with `status` of `in_progress` or `paused` for that template. However, other template assignments for the same user are unaffected — the user can start interviews for other assigned templates concurrently (subject to business rules on maximum concurrent active interviews, see below).

**Concurrent interview limit:** A user may have at most **one** interview with `status = 'in_progress'` at any given time. This is enforced by `startInterview`. A user may have multiple `paused` interviews (for different templates) and can resume any one of them, subject to the single-active constraint. This prevents resource contention (Redis sessions, SSE streams, STT connections) while still allowing multi-template enrollment.

### Admin Audit Trail

All administrative mutations are logged to an `admin_audit_log` table via Prisma middleware. This provides a complete, immutable record of who changed what and when — critical for interview data that may have legal significance. See the `admin_audit_log` table definition in Section 4 and the middleware specification in Section 6.

### Cost Tracking

Each interview turn incurs costs across three external services: Claude (LLM), ElevenLabs STT, and ElevenLabs TTS. Cost-relevant metrics are captured at the `interview_responses` level (per-turn token counts, audio duration billed, TTS characters) and aggregated at the `interviews` level (total tokens, total audio, total TTS characters). This enables per-interview and per-user cost reporting in the admin interface without requiring a separate analytics pipeline. See cost fields on `interview_responses` and `interviews` tables.

### Atomic Turn Lock

During an active interview, the backend enforces an **atomic turn lock** in Redis to prevent race conditions between overlapping client submissions. When the backend begins streaming an LLM completion (SSE stream opens), it sets an `is_streaming` flag on the Redis session for that interview. The flag is cleared when the SSE stream closes (all tokens received and `current_turn_llm_text` is fully cached).

While `is_streaming` is `true`, the backend rejects any `submitResponse`, `skipQuestion`, or `saveDraft` calls for that interview with an `INVALID_STATE` error (details: `{ reason: "TURN_IN_PROGRESS", message: "Cannot submit while the interviewer is still responding." }`). This prevents a fast-submitting client or script from firing a response while the previous turn's LLM completion is still in flight, which would corrupt the turn sequence and the `question_text_as_asked` snapshot.

The frontend should disable submission controls while the LLM is streaming and display the lock state visually, but the backend lock is the authoritative enforcement — the frontend disable is a UX convenience, not a security boundary.

**Lock lifecycle:**
1. Backend initiates LLM call → sets `is_streaming = true` in Redis session
2. Backend streams tokens to client via SSE, accumulating full text in `current_turn_llm_text`
3. SSE stream closes (final token received) → backend sets `is_streaming = false`, `current_turn_llm_text` is finalized
4. Client may now submit response, skip, or save draft

**Failure case:** If the SSE stream errors or the LLM call fails, the backend must clear `is_streaming` as part of error recovery (see conversation-protocol-spec-v3.md Section 15) to avoid permanently locking the session. The reconciliation Lambda (Scan 1) should also check for sessions where `is_streaming` has been `true` for longer than 60 seconds and reset it.

---

## 4. Data Model

### Entity Relationship Summary

```
tags (master reference, soft-deletable)
  ├── question_tags (junction) → questions (soft-deletable)
  └── user_tags (junction) → users

users
  ├── user_templates (junction with assignment metadata) → interview_templates
  └── template_assignment_history (audit trail)

interview_templates
  └── template_questions (junction with ordering, bucketing, follow-up triggers) → questions

interviews (session record)
  ├── interview_responses (snapshot of question + answer + artifacts + cost metrics)
  └── response_drafts (silent redo tracking, admin-only)

user_consent_records (consent audit trail)
  └── user_id FK → users

admin_audit_log (immutable admin action log)
  └── actor_id FK → users
```

### Table Definitions

#### `tags`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| label | VARCHAR(255) | NOT NULL, UNIQUE |
| tag_type | VARCHAR(50) | NOT NULL, CHECK(tag_type IN ('role','department','topic','seniority','domain')) |
| is_active | BOOLEAN | NOT NULL DEFAULT TRUE |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| updated_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** Controlled vocabulary. Only administrators can create or edit tags. Uses VARCHAR with CHECK constraint instead of Postgres ENUM for `tag_type` to allow adding types without ALTER TYPE. Deactivated tags (`is_active = false`) are excluded from selection UIs but their associations remain intact.

#### `questions`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| text | TEXT | NOT NULL |
| category | VARCHAR(100) | NOT NULL |
| is_active | BOOLEAN | NOT NULL DEFAULT TRUE |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| updated_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** The `category` field is a first-class field, not a tag. It represents the question's thematic purpose: motivation, process, challenge, opinion, experience, or whatever categories you define. Used for bucket-based diversity in templates and for deduplication guidance to the LLM. A question has exactly one category. Tags are separate and represent topical/demographic associations. Deactivated questions are excluded from the question bank but remain in existing templates.

#### `question_tags`

| Column | Type | Constraints |
|---|---|---|
| question_id | UUID | FOREIGN KEY → questions(id), NOT NULL |
| tag_id | UUID | FOREIGN KEY → tags(id), NOT NULL |

**Constraints:** Composite primary key on (question_id, tag_id).

#### `users`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| name | VARCHAR(255) | NOT NULL |
| email | VARCHAR(255) | NOT NULL, UNIQUE |
| role | VARCHAR(20) | NOT NULL DEFAULT 'user', CHECK(role IN ('admin','user')) |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| updated_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** The `id` field corresponds to the Cognito user ID (sub claim from JWT). The row is created automatically by a post-confirmation Lambda trigger when the Cognito account is created. Template assignments are managed via the `user_templates` junction table (see below), not via a direct FK on this table.

**Role column:** The `role` column is the **local cache** of the user's Cognito group membership. Cognito remains the source of truth for authentication and authorization (the JWT `cognito:groups` claim is what the API middleware checks for access control). The `role` column exists so that admin UI queries (e.g., listing users with their roles, filtering by role) can be served from a single database query without calling the Cognito `AdminListGroupsForUser` API per user, which does not scale. The post-confirmation Lambda sets `role` based on the Cognito groups the user is added to at invite time. If a user's Cognito group membership is changed after creation, the `role` column must be updated — this is handled by an admin mutation `syncUserRole(userId)` that reads the current Cognito groups and updates the local column. The API middleware always trusts the JWT claim, not the database column, for authorization decisions.

#### `user_templates`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| template_id | UUID | FOREIGN KEY → interview_templates(id), NOT NULL |
| assigned_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| assigned_by | UUID | FOREIGN KEY → users(id), NOT NULL |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active', CHECK(status IN ('active','completed','removed')) |
| completed_at | TIMESTAMP WITH TIME ZONE | — |
| removed_at | TIMESTAMP WITH TIME ZONE | — |

**Constraints:** UNIQUE on (user_id, template_id) WHERE status = 'active'. This prevents duplicate active assignments of the same template to the same user, while allowing re-assignment after a previous assignment was completed or removed.

**Notes:** This is the junction table that enables many-to-many assignment between users and templates. `assigned_by` is NOT NULL — every assignment is admin-initiated and the assigning admin's user ID is always recorded. Only published templates should be assignable (enforced at application layer). The `status` field tracks the lifecycle: 'active' means the user can start or continue interviews for this template; 'completed' means all interviews for this assignment are done; 'removed' means an admin removed the assignment. When a user completes an interview for a template, the assignment status is updated to 'completed'. An assignment cannot be removed (`status = 'removed'`) while the user has an interview with `status` of `in_progress` or `paused` for that template.

#### `user_tags`

| Column | Type | Constraints |
|---|---|---|
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| tag_id | UUID | FOREIGN KEY → tags(id), NOT NULL |

**Constraints:** Composite primary key on (user_id, tag_id).

#### `template_assignment_history`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| template_id | UUID | FOREIGN KEY → interview_templates(id), NOT NULL |
| assigned_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| assigned_by | UUID | FOREIGN KEY → users(id), NOT NULL |
| unassigned_at | TIMESTAMP WITH TIME ZONE | — |
| unassigned_reason | VARCHAR(100) | — |

**Notes:** Every assignment and removal creates a row. When removed, the old row gets `unassigned_at` set and `unassigned_reason` populated. Values for `unassigned_reason`: 'completed', 'template_archived', 'admin_removed'. `assigned_by` is NOT NULL — every assignment is admin-initiated and the assigning admin's user ID is always recorded.

#### `interview_templates`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| name | VARCHAR(255) | NOT NULL |
| description | TEXT | — |
| status | VARCHAR(20) | NOT NULL DEFAULT 'draft', CHECK(status IN ('draft','published','archived')) |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| updated_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** Only templates with status 'published' are assignable to users. 'draft' templates are in progress. 'archived' templates are retired but preserved for historical reference. Do not delete templates; archive them. Uses VARCHAR with CHECK instead of ENUM.

#### `template_questions`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| template_id | UUID | FOREIGN KEY → interview_templates(id), NOT NULL |
| question_id | UUID | FOREIGN KEY → questions(id), NOT NULL |
| sequence_order | INTEGER | NOT NULL |
| category_bucket | VARCHAR(100) | NOT NULL |
| is_required | BOOLEAN | NOT NULL DEFAULT TRUE |
| followup_triggers | JSONB | DEFAULT '[]' |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Constraints:** UNIQUE on (template_id, question_id). UNIQUE on (template_id, sequence_order).

**Notes:** `category_bucket` is a label for grouping within this template context. It may differ from the question's master `category` field. `is_required` determines whether the LLM must ask this question (true) or may skip it (false). When removing a question, check if its ID is referenced in any trigger's `suggested_followup_question_ids` — block removal if so.

#### `followup_triggers` JSONB Structure

```json
[
  {
    "id": "uuid-string",
    "trigger_type": "keyword | sentiment | length | always",
    "keywords": ["challenge", "difficult", "problem"],
    "sentiment": "positive | negative | neutral",
    "length_condition": "less_than_100_words | more_than_500_words",
    "suggested_followup_question_ids": ["uuid-1", "uuid-2"],
    "created_at": "ISO-8601 timestamp"
  }
]
```

**Notes:**
- `keywords`, `sentiment`, and `length_condition` are conditionally present based on `trigger_type`
- `suggested_followup_question_ids` references question IDs that exist within the same template
- Multiple triggers can exist per question and are evaluated independently
- **The LLM evaluates all triggers** — these definitions are passed in the system prompt, not processed by application code
- If a trigger references a question no longer in the template, the LLM skips it

#### `interviews`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| template_id | UUID | FOREIGN KEY → interview_templates(id), NOT NULL |
| status | VARCHAR(20) | NOT NULL DEFAULT 'scheduled', CHECK(status IN ('scheduled','in_progress','paused','completed','abandoned')) |
| session_snapshot | JSONB | — |
| paused_at | TIMESTAMP WITH TIME ZONE | — |
| started_at | TIMESTAMP WITH TIME ZONE | — |
| completed_at | TIMESTAMP WITH TIME ZONE | — |
| total_llm_prompt_tokens | INTEGER | DEFAULT 0 |
| total_llm_completion_tokens | INTEGER | DEFAULT 0 |
| total_stt_duration_seconds | NUMERIC(10,2) | DEFAULT 0 |
| total_tts_characters | INTEGER | DEFAULT 0 |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** `template_id` is denormalized here intentionally — it records which template was active for this session independent of the user's current assignments. `session_snapshot` stores the Redis session state when an interview is paused (see conversation-protocol-spec-v3.md Section 10). `status` includes 'paused' (not in v1). The `scheduled` status is reserved for a future workflow where interviews are pre-created and scheduled for a specific time before the user starts them (e.g., calendar-based booking). No current workflow produces or consumes `scheduled` interviews — it exists in the CHECK constraint to avoid a migration when the scheduling feature is built. Uses VARCHAR with CHECK instead of ENUM. Cost summary fields (`total_llm_prompt_tokens`, `total_llm_completion_tokens`, `total_stt_duration_seconds`, `total_tts_characters`) are updated incrementally by the backend after each turn and by the cleaning pipeline. They provide interview-level cost aggregation without requiring a SUM query across all responses.

#### `interview_responses`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| interview_id | UUID | FOREIGN KEY → interviews(id), NOT NULL |
| question_id | UUID | FOREIGN KEY → questions(id), NOT NULL |
| question_text_as_asked | TEXT | NOT NULL |
| sequence_number | INTEGER | NOT NULL |
| tags_at_time | JSONB | DEFAULT '[]' |
| category_bucket | VARCHAR(100) | — |
| is_followup | BOOLEAN | NOT NULL DEFAULT FALSE |
| parent_response_id | UUID | FOREIGN KEY → interview_responses(id) |
| is_skipped | BOOLEAN | NOT NULL DEFAULT FALSE |
| input_mode | VARCHAR(10) | NOT NULL DEFAULT 'voice', CHECK(input_mode IN ('voice','text','edited')) |
| s3_audio_key | VARCHAR(1024) | — |
| s3_audio_bucket | VARCHAR(255) | — |
| audio_mime_type | VARCHAR(100) | — |
| audio_duration_seconds | NUMERIC(10,2) | — |
| audio_upload_status | VARCHAR(20) | NOT NULL DEFAULT 'not_applicable', CHECK(audio_upload_status IN ('pending','uploaded','failed','not_applicable')) |
| stt_engine | VARCHAR(100) | — |
| raw_transcription | TEXT | — |
| stt_confidence_score | NUMERIC(5,4) | — |
| cleaned_markdown | TEXT | — |
| cleaning_model | VARCHAR(100) | — |
| cleaned_at | TIMESTAMP WITH TIME ZONE | — |
| processing_status | VARCHAR(20) | NOT NULL DEFAULT 'pending', CHECK(processing_status IN ('pending','cleaning','cleaned','error')) |
| error_message | TEXT | — |
| llm_prompt_tokens | INTEGER | — |
| llm_completion_tokens | INTEGER | — |
| llm_model | VARCHAR(100) | — |
| llm_latency_ms | INTEGER | — |
| stt_duration_billed_seconds | NUMERIC(10,2) | — |
| tts_characters_billed | INTEGER | — |
| responded_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:**
- `question_id` is NOT NULL — every response is tied to a specific question record. The `question_text_as_asked` snapshot is the source of truth for what was asked, but `question_id` provides the FK link for analytics and deduplication.
- `question_text_as_asked` captures the **exact text the LLM delivered to the user**, not the original template question text. If the LLM rephrased or adapted the question conversationally, this field reflects the adapted version. This value is sourced from the `current_turn_llm_text` field cached in the Redis session during SSE streaming (see Section 3: Snapshot-Based Response Storage).
- `tags_at_time` is a JSONB snapshot of tags active at interview time. Intentionally denormalized.
- `is_followup` and `parent_response_id` track follow-up lineage.
- `is_skipped` marks responses where the user explicitly skipped the question.
- `input_mode` tracks how the response was created: 'voice' (STT), 'text' (typed), 'edited' (voice STT manually revised).
- Audio fields are populated **progressively during the interview** via background upload and `confirmAudioUpload` mutation (see conversation-protocol-spec-v3.md Section 2). They are null for text responses and skipped questions.
- `audio_upload_status` tracks background upload progress: 'pending' when voice response submitted, 'uploaded' when confirmed, 'failed' after retries exhausted, 'not_applicable' for text/skipped.
- `error_message` stores the failure reason when `processing_status` is 'error'.
- `raw_transcription` is null for skipped questions, populated from STT for voice, or contains typed text for text input.
- Cost tracking fields (`llm_prompt_tokens`, `llm_completion_tokens`, `llm_model`, `llm_latency_ms`, `stt_duration_billed_seconds`, `tts_characters_billed`) are populated by the backend after each turn. These enable per-interview and per-user cost aggregation. `stt_duration_billed_seconds` is the audio duration sent to ElevenLabs STT (may differ from `audio_duration_seconds` due to silence trimming). `tts_characters_billed` is the character count sent to ElevenLabs TTS for the LLM response that preceded this user response. `llm_*` fields track the LLM call that generated the question/prompt for this turn.
- Uses VARCHAR with CHECK instead of ENUM throughout.

#### `response_drafts`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| interview_id | UUID | FOREIGN KEY → interviews(id), NOT NULL |
| question_id | UUID | FOREIGN KEY → questions(id) |
| draft_number | INTEGER | NOT NULL |
| content | TEXT | NOT NULL |
| input_mode | VARCHAR(10) | NOT NULL, CHECK(input_mode IN ('voice','text','edited')) |
| stt_confidence_score | NUMERIC(5,4) | — |
| s3_audio_key | VARCHAR(1024) | — |
| s3_audio_bucket | VARCHAR(255) | — |
| audio_mime_type | VARCHAR(100) | — |
| audio_duration_seconds | NUMERIC(10,2) | — |
| audio_upload_status | VARCHAR(20) | DEFAULT 'pending', CHECK(audio_upload_status IN ('pending','uploaded','failed')) |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Constraints:** UNIQUE on (interview_id, question_id, draft_number).

**Notes:** Stores every discarded response when a user clicks "Redo." Invisible to end users. Used for debugging STT quality and understanding user behavior. Audio from redone voice responses is uploaded to S3 for comparison. See conversation-protocol-spec-v3.md Section 7 for the full draft lifecycle.

#### `user_consent_records`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| consent_type | VARCHAR(50) | NOT NULL, CHECK(consent_type IN ('data_processing','audio_recording','ai_interaction')) |
| consent_version | VARCHAR(20) | NOT NULL |
| granted_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| revoked_at | TIMESTAMP WITH TIME ZONE | — |
| ip_address | VARCHAR(45) | — |

**Constraints:** UNIQUE on (user_id, consent_type, consent_version) WHERE revoked_at IS NULL.

**Notes:** Immutable audit trail — consent records are never updated, only new rows are inserted. Revocation inserts a new row or sets `revoked_at` on the existing row. `consent_version` tracks which version of the consent text the user agreed to, enabling re-consent when terms change. See Section 20 for the full consent workflow.

#### `admin_audit_log`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| actor_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| action | VARCHAR(100) | NOT NULL |
| entity_type | VARCHAR(50) | NOT NULL |
| entity_id | UUID | NOT NULL |
| changes | JSONB | NOT NULL DEFAULT '{}' |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Notes:** Immutable, append-only table. No UPDATE or DELETE operations are permitted — rows are never modified after insertion. `actor_id` is the admin user who performed the action (derived from the Cognito JWT). `action` is the mutation name (e.g., `createTag`, `updateTemplate`, `assignTemplateToUser`, `updateQuestion`). `entity_type` is the table/model affected (e.g., `tag`, `question`, `template`, `user`). `entity_id` is the primary key of the affected record. `changes` is a JSONB object containing the mutation input — the fields that were set or changed. For create operations, this contains all input fields. For update operations, this contains only the changed fields with their new values. **PII note:** `changes` may contain question text or tag labels but must NEVER be exported to ClickHouse. This table is queryable only via the database.

**Populated by Prisma middleware** — see Section 6 for implementation details.

### Index Strategy

Beyond automatic PK and FK indexes, the following composite indexes must be defined in the Prisma schema via `@@index`:

| Table | Columns | Rationale |
|---|---|---|
| interview_responses | (interview_id, processing_status) | Cleaning Lambda queries by interview + status |
| interview_responses | (processing_status, responded_at) | Reconciliation job scans for stuck states |
| interview_responses | (input_mode, audio_upload_status, responded_at) | Audio upload reconciliation |
| interviews | (user_id, status) | Interview history queries and active interview blocking checks |
| interviews | (status, paused_at) | Auto-abandonment reconciliation |
| tags | (tag_type, is_active) | Filtered tag queries |
| questions | (is_active) | Filtered question bank queries |
| interview_templates | (status) | Filtered template queries |
| template_assignment_history | (user_id) | Assignment history lookups |
| user_templates | (user_id, status) | Active assignment lookups for a user |
| user_templates | (template_id, status) | Users assigned to a template |
| response_drafts | (interview_id, question_id) | Draft lookups per question |
| user_consent_records | (user_id, consent_type) | Consent status lookups |
| admin_audit_log | (entity_type, entity_id) | Lookup audit history for a specific record |
| admin_audit_log | (actor_id, created_at) | Lookup actions by a specific admin |

---

## 5. Observability and Error Handling

### ClickHouse Cloud via OpenTelemetry

ClickHouse Cloud is the **sole observability backend** for the Arena platform. All traces, metrics, and structured logs flow there via the OpenTelemetry SDK.

**Implementation:**
- OpenTelemetry Node.js SDK with auto-instrumentation enabled on the Fastify backend
- Auto-instrumentation covers: HTTP requests, database queries (Prisma), Redis operations, external API calls (Claude, ElevenLabs)
- Custom spans for: LLM inference calls (model, token count, latency), STT/TTS operations, interview state transitions, cleaning pipeline steps
- Structured log events for: all GraphQL errors, business rule violations, audio upload events, pipeline state changes

**OTel Collector:**
- Runs as a sidecar container in the ECS task definition (both API and Lambda)
- Exports to ClickHouse Cloud's OTLP-compatible endpoint
- Configured via environment variables: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`

**PII Boundary — Strictly Enforced:**

The following data types must NEVER appear in telemetry sent to ClickHouse:
- User names or email addresses
- Interview transcription content (raw or cleaned)
- Question text
- Any knowledge fabric content
- Any personally identifiable information
- Contents of `admin_audit_log.changes` (may contain question text or tag labels)

The following data types ARE permitted:
- UUIDs (user IDs, interview IDs, response IDs, question IDs)
- Error codes and error messages (application-generated, not user content)
- Stack traces
- Response times and latencies
- HTTP status codes
- Model names and identifiers
- Timestamps
- Counts and metrics (token counts, question counts, cost metrics, etc.)
- Alert codes and severity levels

**PII Scrubbing:** The OTel SDK must be configured with attribute processors that strip or redact any attributes matching PII patterns before export. This is a defense-in-depth measure — application code should not include PII in spans or logs in the first place.

### Alert Definitions

Critical conditions must emit structured alert events to ClickHouse with consistent fields for filtering and escalation. All alerts are structured log events with the following standard attributes:

| Attribute | Type | Description |
|---|---|---|
| `alert.code` | string | Unique alert identifier (see table below) |
| `alert.severity` | string | `critical`, `warning`, or `info` |
| `alert.component` | string | Service or subsystem that emitted the alert |
| `alert.message` | string | Human-readable description (no PII) |
| `alert.interview_id` | string (UUID) | Interview context, if applicable |
| `alert.count` | integer | Number of affected records, if applicable |

**Defined Alerts:**

| Alert Code | Severity | Component | Condition |
|---|---|---|---|
| `CLEANING_PIPELINE_DLQ` | critical | cleaning-lambda | Message sent to dead letter queue after 3 failures |
| `CLEANING_PIPELINE_ERROR_RATE` | critical | cleaning-lambda | >10% of responses in a batch fail cleaning |
| `LLM_API_FAILURE` | critical | interview-engine | Claude API returns 5xx or times out during active interview |
| `LLM_TTFT_EXCEEDED` | warning | interview-engine | LLM time-to-first-token exceeds 3000ms (see Section 21) |
| `STT_PROXY_FAILURE` | critical | stt-proxy | ElevenLabs STT WebSocket connection fails or drops during active interview |
| `TTS_API_FAILURE` | warning | frontend | ElevenLabs TTS API returns error (frontend logs via API endpoint) |
| `AUDIO_UPLOAD_FAILURE_BATCH` | warning | reconciliation | >5 audio uploads in `failed` status found in single reconciliation scan |
| `STUCK_CLEANING_BATCH` | warning | reconciliation | >10 responses stuck in `cleaning` status found in single scan |
| `REDIS_CONNECTION_FAILURE` | critical | api-server | Redis connection lost or unreachable |
| `DB_CONNECTION_POOL_EXHAUSTED` | critical | api-server | Prisma connection pool at capacity |
| `INTERVIEW_ABANDONED_AUTO` | info | reconciliation | Interview auto-abandoned after 72h pause |
| `RECONCILIATION_SCAN_FAILURE` | critical | reconciliation | Reconciliation Lambda itself errors |
| `EXTERNAL_SERVICE_LATENCY` | warning | api-server | Any external service call (Claude, ElevenLabs) exceeds 10s |
| `COST_THRESHOLD_INTERVIEW` | warning | interview-engine | Single interview exceeds configurable token/cost threshold |
| `TURN_LOCK_STUCK` | warning | reconciliation | Redis session `is_streaming` flag has been true for >60 seconds |

**ClickHouse filtering:** All alerts can be queried via `SELECT * FROM otel_logs WHERE LogAttributes['alert.code'] = 'CLEANING_PIPELINE_DLQ'`. Teams should set up ClickHouse materialized views or external alerting integrations (e.g., PagerDuty, Slack webhook) to monitor critical alerts. The specific alerting integration is outside the scope of this spec, but the structured alert format ensures any integration can filter on `alert.code` and `alert.severity`.

### GraphQL Error Handling

All GraphQL errors use **typed error codes** via Apollo Server's error extensions. Every resolver follows the same pattern.

**Standard Error Code Vocabulary:**

| Code | HTTP Equivalent | When Used |
|---|---|---|
| `NOT_FOUND` | 404 | Resource does not exist |
| `DUPLICATE_ENTRY` | 409 | Unique constraint violation (e.g., duplicate tag label) |
| `INVALID_STATE` | 422 | Business rule violation (e.g., assigning archived template, publishing template with zero questions, submitting during active turn lock) |
| `UNAUTHORIZED` | 401 | Missing or invalid Cognito JWT |
| `FORBIDDEN` | 403 | Valid JWT but insufficient permissions (e.g., non-admin calling admin mutation) |
| `VALIDATION_ERROR` | 400 | Invalid input (missing required fields, wrong types, out of range) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `EXTERNAL_SERVICE_ERROR` | 502 | Claude API, ElevenLabs, or other external service failure |
| `RATE_LIMITED` | 429 | Too many requests (future use) |
| `CONSENT_REQUIRED` | 403 | User has not granted required consent (see Section 20) |

**Error Response Format:**

```json
{
  "errors": [
    {
      "message": "Cannot assign archived template to user",
      "extensions": {
        "code": "INVALID_STATE",
        "details": {
          "templateId": "uuid",
          "templateStatus": "archived"
        }
      }
    }
  ]
}
```

**Error → ClickHouse Flow:**
1. Every error caught by a resolver or middleware is logged as a structured OTel event
2. The event includes: error code, resolver name, operation name, user ID (UUID only), timestamp, and stack trace (for INTERNAL_ERROR only)
3. The event does NOT include: request variables that contain user content (transcriptions, question text, etc.)
4. Business rule violations (INVALID_STATE, DUPLICATE_ENTRY) are logged at WARN level
5. Infrastructure errors (INTERNAL_ERROR, EXTERNAL_SERVICE_ERROR) are logged at ERROR level

**Specific Business Rule Validations:**

| Operation | Validation | Error Code |
|---|---|---|
| `createTag` | Label already exists | DUPLICATE_ENTRY |
| `assignTemplateToUser` | Template status is not 'published' | INVALID_STATE |
| `assignTemplateToUser` | Template not found | NOT_FOUND |
| `assignTemplateToUser` | User already has an active assignment for this template | DUPLICATE_ENTRY |
| `removeTemplateFromUser` | User has an interview with status 'in_progress' or 'paused' for this template | INVALID_STATE (with blocking interview details: interview ID, status, started_at, elapsed duration, percentage of questions answered) |
| `updateTemplate(status: 'published')` | Template has zero questions | INVALID_STATE |
| `startInterview` | Authenticated user has no active assignment for the specified template | INVALID_STATE |
| `startInterview` | Authenticated user already has an in_progress interview (for any template) | INVALID_STATE |
| `startInterview` | User has not granted all required consent types | CONSENT_REQUIRED |
| `submitResponse` | Session `is_streaming` flag is true (turn lock active) | INVALID_STATE (with details: `{ reason: "TURN_IN_PROGRESS" }`) |
| `skipQuestion` | Session `is_streaming` flag is true (turn lock active) | INVALID_STATE (with details: `{ reason: "TURN_IN_PROGRESS" }`) |
| `saveDraft` | Session `is_streaming` flag is true (turn lock active) | INVALID_STATE (with details: `{ reason: "TURN_IN_PROGRESS" }`) |
| `removeQuestionFromTemplate` | Question referenced in another question's follow-up triggers | INVALID_STATE |
| `updateTag(isActive: false)` | (Warning only, not blocking) Tag used in published templates | Succeeds with warning in response |
| `updateQuestion(isActive: false)` | (Warning only, not blocking) Question in published templates | Succeeds with warning in response |

---

## 6. Authentication and Authorization

### Cognito Configuration

**User Pool Settings:**
- Admin-invite-only (self-signup disabled)
- Email/password authentication
- Email verification required
- Password policy: minimum 12 characters, require uppercase, lowercase, number, symbol
- MFA: optional for v1, can be enforced later

**Groups:**
- `admin` — full access to all mutations and queries. Can manage tags, questions, templates, users, and view all interview data.
- `user` — can take interviews assigned to them, view their own interview history. Cannot access admin CRUD operations.

**Group Claim:** The Cognito JWT includes a `cognito:groups` claim. The API middleware checks this claim to enforce role-based access.

**Admin Group Name in Code:** The admin group is referenced as `admin` (lowercase) throughout the codebase. Do not use 'Admin', 'Administrators', or any variant.

### User Sync: Post-Confirmation Lambda

When an admin creates a new user in Cognito (via admin invite), a **post-confirmation Lambda trigger** fires and creates the corresponding row in the `users` table.

**Lambda behavior:**
1. Triggered by Cognito post-confirmation event
2. Extracts: `sub` (becomes `users.id`), `email`, `name` (from Cognito custom attributes or defaults to email prefix)
3. Determines the user's Cognito group membership and sets `users.role` accordingly ('admin' or 'user')
4. Creates row in `users` table with these values
5. If the row already exists (idempotency): skip silently
6. Errors are logged to ClickHouse but do not block the Cognito confirmation

**Source of truth:** Cognito is the source of truth for authentication (can this person log in?) and authorization (JWT `cognito:groups` claim is checked by API middleware). The `users` table is the source of truth for application data (template assignments, tags, interview history). The `users.role` column is a cached copy of the Cognito group for query efficiency — it is NOT used for authorization decisions. The `users.id` = Cognito `sub` link connects them.

**CDK requirement:** This Lambda must be defined in the Foundation Stack alongside the Cognito user pool, since it's a Cognito trigger.

### Admin Audit Logging via Prisma Middleware

A Prisma middleware function intercepts all `create` and `update` operations on audited models and writes a row to `admin_audit_log`. This ensures every administrative mutation is logged without requiring each resolver to explicitly call an audit function.

**Audited models:** `Tag`, `Question`, `InterviewTemplate`, `TemplateQuestion`, `User` (for role changes only — not interview-time updates), `UserTemplate` (for assignment and removal operations).

**Middleware behavior:**
1. On every `create` or `update` to an audited model, the middleware extracts the actor ID from the request context (Cognito JWT `sub` claim, threaded through Prisma's `$extends` or middleware context).
2. It constructs an `admin_audit_log` row with: `actor_id`, `action` (the mutation name, passed via context), `entity_type` (the Prisma model name), `entity_id` (the record's primary key), and `changes` (the input data for creates; the changed fields for updates).
3. The audit log write is performed in the **same database transaction** as the mutation itself, ensuring atomicity — if the mutation fails, no audit row is written, and vice versa.
4. The middleware does NOT log reads (queries), interview-time writes (`submitResponse`, `skipQuestion`, etc.), or pipeline writes (`updateCleanedContent`). Only admin-initiated mutations on master data are logged.

**Context threading:** The authenticated user's ID and the mutation name must be available in the Prisma middleware context. This is achieved by using Prisma's `$extends` client extension to attach request context, or by wrapping Prisma calls in a context-aware service layer that passes the actor ID and operation name.

---

## 7. ElevenLabs API Contract

### STT (Speech-to-Text)

- **Product:** ElevenLabs real-time speech-to-text WebSocket API
- **Endpoint:** `wss://api.elevenlabs.io/v1/speech-to-text/ws` (verify against current ElevenLabs docs during implementation)
- **Authentication:** API key passed in WebSocket connection parameters
- **Audio format requirements:** WebM/Opus or PCM WAV, 16kHz sample rate minimum, mono channel
- **WebSocket message format:** Binary audio frames sent from client → text transcription results returned as JSON
- **Latency:** Partial transcripts stream back within ~300ms of audio receipt

### TTS (Text-to-Speech)

- **Product:** ElevenLabs text-to-speech REST API
- **Endpoint:** `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream`
- **Authentication:** API key in `xi-api-key` header
- **Voice:** Single default voice for v1. Voice ID configured as environment variable `ELEVENLABS_DEFAULT_VOICE_ID`.
- **Output format:** MP3 or PCM audio stream
- **Usage pattern:** Frontend sends sentence-level chunks for low-latency playback (see conversation-protocol-spec-v3.md Section 14)

### API Key Management

- **Secret name in Secrets Manager:** `arena/elevenlabs-api-key`
- **Separate from Claude API key** — they are different services with different keys
- **Claude API key secret name:** `arena/claude-api-key`
- **Access:** Fargate tasks and Lambda functions reference these secrets via environment variables injected from Secrets Manager
- **TTS key for frontend:** Delivered via a short-lived token endpoint on the backend (see conversation-protocol-spec-v3.md Section 12)

---

## 8. GraphQL Schema Design

### Pagination

Queries that return growing collections use **cursor-based pagination** with a standard connection pattern:

```graphql
type QuestionConnection {
  edges: [QuestionEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type QuestionEdge {
  cursor: String!
  node: Question!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

**Paginated queries:** `getQuestions`, `getInterviewsByUser`, `getInterviewResponses`, `getDraftsForResponse`, `getTemplateAssignmentHistory`, `getAuditLog`

**Non-paginated queries (small bounded lists):** `getTags`, `getTemplates` — these return all matching records directly.

**Default page size:** 25. Maximum page size: 100.

### Types

- `Tag`: id, label, tagType, isActive
- `Question`: id, text, category, isActive, tags (resolved via question_tags)
- `InterviewTemplate`: id, name, description, status, questions (resolved via template_questions with ordering and trigger metadata)
- `TemplateQuestion`: id, question, sequenceOrder, categoryBucket, isRequired, followupTriggers
- `User`: id, name, email, role, assignedTemplates (resolved from user_templates where status = 'active'), tags, consentStatus (resolved from user_consent_records)
- `UserTemplateAssignment`: id, template (resolved), assignedAt, assignedBy, status, completedAt
- `Interview`: id, user, template, status, startedAt, completedAt, pausedAt, responses, costSummary
- `InterviewCostSummary`: totalLlmPromptTokens, totalLlmCompletionTokens, totalSttDurationSeconds, totalTtsCharacters
- `InterviewResponse`: id, questionTextAsAsked, sequenceNumber, isFollowup, isSkipped, inputMode, categoryBucket, rawTranscription, cleanedMarkdown, processingStatus, errorMessage, respondedAt, audioMetadata, audioUploadStatus
- `AudioMetadata`: s3Key, mimeType, durationSeconds
- `ResponseDraft`: id, draftNumber, content, inputMode, sttConfidenceScore, audioUploadStatus, createdAt
- `TemplateAssignmentRecord`: id, templateId, assignedAt, assignedBy, unassignedAt, unassignedReason
- `ConsentStatus`: dataProcessing (Boolean), audioRecording (Boolean), aiInteraction (Boolean), allGranted (Boolean)
- `AuditLogEntry`: id, actorId, actorName (resolved), action, entityType, entityId, changes (JSONB), createdAt

### Queries

- `getUser(id)` — returns user with tags, assigned templates (active assignments), role, and consent status
- `getMyAssignedTemplates` — returns the authenticated user's active template assignments with interview status for each (not started, in progress, paused, completed). Used by the interview landing page to present available interviews.
- `getInterview(id)` — returns interview with all responses and cost summary
- `getInterviewsByUser(userId, first, after)` — **paginated**, returns all interviews for a user
- `getTemplate(id)` — returns template with full question set, ordering, and triggers
- `getTemplates(status)` — returns templates filtered by status (not paginated — bounded list)
- `getQuestions(filters, includeInactive, first, after)` — **paginated**, filtered by tags, category, or search text. `includeInactive` defaults to false.
- `getTags(tagType, includeInactive)` — returns tags, optionally filtered by type. `includeInactive` defaults to false. Not paginated.
- `getInterviewResponse(id)` — returns a single response with full artifact data
- `getDraftsForResponse(interviewId, questionId, first, after)` — **paginated**, admin only
- `getTemplateAssignmentHistory(userId, first, after)` — **paginated**, admin only
- `getMyConsentStatus` — returns the authenticated user's current consent status across all consent types
- `getAuditLog(entityType, entityId, actorId, first, after)` — **paginated**, admin only. Filterable by entity, actor, or both.

### Mutations

**Tag management (admin only):**
- `createTag(label, tagType)` — fails with DUPLICATE_ENTRY if label exists
- `updateTag(id, label, tagType, isActive)` — `isActive` parameter for soft-delete

**Question management (admin only):**
- `createQuestion(text, category, tagIds)`
- `updateQuestion(id, text, category, tagIds, isActive)` — `isActive` parameter for soft-delete

**Template management (admin only):**
- `createTemplate(name, description)` — creates in draft status
- `updateTemplate(id, name, description, status)` — publishing fails with INVALID_STATE if zero questions
- `addQuestionToTemplate(templateId, questionId, sequenceOrder, categoryBucket, isRequired, followupTriggers)`
- `updateTemplateQuestion(id, sequenceOrder, categoryBucket, isRequired, followupTriggers)`
- `removeQuestionFromTemplate(id)` — fails with INVALID_STATE if referenced in follow-up triggers

**User management (admin only):**
- `assignTemplateToUser(userId, templateId)` — creates a row in `user_templates` with status 'active' + writes history. Fails if template not published. Fails with DUPLICATE_ENTRY if user already has an active assignment for this template.
- `removeTemplateFromUser(userId, templateId)` — sets user_templates status to 'removed', writes history. Fails with INVALID_STATE if user has an in_progress or paused interview for this template (error details include: interview ID, status, started_at, elapsed duration, and percentage of questions answered).
- `syncUserRole(userId)` — reads the user's current Cognito group membership via `AdminListGroupsForUser` and updates the `role` column in the `users` table to match. Admin only.

**Consent operations:**
- `grantConsent(consentType, consentVersion)` — records user consent. Requires authenticated user.
- `revokeConsent(consentType)` — revokes consent. See Section 20 for implications.

**Data subject operations:**
- `requestDataDeletion` — initiates a data deletion request for the authenticated user. See Section 20.

**Interview operations:**
- `startInterview(templateId)` — **takes no userId parameter; the backend derives the user from the authenticated Cognito JWT** (`sub` claim). The `templateId` parameter specifies which of the user's assigned templates to start an interview for. Creates interview record using the specified template, initializes Redis session, returns first LLM question via SSE stream. Fails if the authenticated user does not have an active assignment for the specified template. Fails if the authenticated user already has an in_progress interview (for any template — only one active interview at a time). Also fails with CONSENT_REQUIRED if the user has not granted all required consent types (`data_processing`, `audio_recording`, `ai_interaction`).
- `submitResponse(interviewId, rawTranscription, inputMode)` — **simplified signature; the backend derives all other response fields from the active Redis session state.** Specifically, the backend populates: `questionId`, `questionTextAsAsked` (from `current_turn_llm_text` cached during SSE streaming), `sequenceNumber`, `isFollowup`, `parentResponseId`, `categoryBucket`, and `tagsAtTime` from the current session state in Redis, which tracks which question is currently being answered and all associated metadata. **Rejected with INVALID_STATE if the session's `is_streaming` flag is true** (see Atomic Turn Lock in Section 3). Returns responseId.
- `completeInterview(interviewId)` — marks completed, updates user_templates assignment status to 'completed', flushes Redis, fires EventBridge event
- `skipQuestion(interviewId)` — **takes no questionId parameter; the backend knows which question is active from the Redis session state.** **Rejected with INVALID_STATE if the session's `is_streaming` flag is true.** Records skip, returns next LLM question via SSE.
- `pauseInterview(interviewId)` — snapshots state, pauses interview
- `resumeInterview(interviewId)` — reconstructs state, returns next LLM question via SSE

**Audio operations:**
- `requestResponseAudioUploadUrl(interviewId, responseId)` — returns presigned S3 PUT URL
- `requestDraftAudioUploadUrl(interviewId, draftId)` — returns presigned S3 PUT URL
- `confirmAudioUpload(responseId, s3Key, mimeType, durationSeconds)` — updates audio fields
- `confirmDraftAudioUpload(draftId, s3Key, mimeType, durationSeconds)` — updates draft audio fields

**Draft operations:**
- `saveDraft(interviewId, content, inputMode, sttConfidenceScore)` — **takes no questionId parameter; the backend derives the current question from the Redis session state.** **Rejected with INVALID_STATE if the session's `is_streaming` flag is true.** Returns draftId.

**Pipeline operations (internal — called by Lambda, not by frontend):**
- `updateCleanedContent(interviewResponseId, cleanedMarkdown, cleaningModel)` — called by cleaning pipeline

**Explicitly prohibited mutations (Claude Code must NOT create these):**
- `deleteTag` — use `updateTag` with `isActive: false`
- `deleteQuestion` — use `updateQuestion` with `isActive: false`
- `deleteTemplate` — use `updateTemplate` with `status: 'archived'`

### Parameter Ownership: Frontend vs. Backend

**Design principle:** The frontend sends only what it uniquely knows (user-generated content and user choices). The backend derives everything it can from its own authoritative state.

| Parameter | Source | Rationale |
|---|---|---|
| `rawTranscription` | Frontend | User-generated content from STT or typed input |
| `inputMode` | Frontend | Frontend knows whether the user spoke, typed, or edited |
| `templateId` (startInterview) | Frontend | User selects which assigned template to interview for |
| `content` (drafts) | Frontend | User-generated draft content |
| `sttConfidenceScore` (drafts) | Frontend | Reported by the STT engine to the frontend |
| `questionId` | Backend (Redis session) | Backend tracks which question is currently active |
| `questionTextAsAsked` | Backend (Redis session — `current_turn_llm_text`) | Captured from the LLM's actual streamed output during the SSE turn, not the original template text. Reflects any rephrasing or adaptation the LLM applied. |
| `sequenceNumber` | Backend (Redis session) | Backend maintains the question counter |
| `isFollowup` | Backend (Redis session) | Backend knows whether the LLM chose a follow-up |
| `parentResponseId` | Backend (Redis session) | Backend tracks follow-up lineage |
| `categoryBucket` | Backend (Redis session) | Loaded from template_questions at session start |
| `tagsAtTime` | Backend (Redis session) | Snapshot of question tags loaded at session start |
| Cost fields | Backend | Captured from LLM/STT/TTS API responses by backend |

This eliminates an entire class of bugs where the frontend and backend disagree on interview state, and prevents any possibility of a caller spoofing response metadata.

### REST Endpoints

- `GET /api/tts-token` — returns short-lived ElevenLabs TTS token (requires Cognito JWT)
- `GET /api/interview/:id/stream` — SSE endpoint for LLM responses, idle prompts, auto-pause notifications (requires Cognito JWT)
- `POST /api/heartbeat` — interview session heartbeat (requires Cognito JWT)

### Subscriptions (Deferred)

- `interviewResponseProcessingUpdated(interviewId)` — real-time processing status updates. Polling is acceptable for v1.

---

## 9. LLM Interview Orchestration

### Pre-Interview Setup

When an interview starts, the backend:
1. Identifies the user from the authenticated Cognito JWT (`sub` claim)
2. Verifies the user has granted all required consent types (see Section 20)
3. Verifies the user has an active assignment for the specified template via `user_templates`
4. Fetches all `template_questions` for that template, ordered by `sequence_order`
5. Separates required vs. optional questions
6. Groups questions by `category_bucket`
7. Loads all `followup_triggers` for each question
8. Constructs the interview state object and system prompt
9. Initializes the Redis session with interview state, empty transcript buffer, question tracking, `is_streaming = false`, and `current_turn_llm_text = null`

### System Prompt Structure

The LLM receives a system prompt containing:
- The template name and description (research context)
- The full list of required questions, organized by category bucket, with IDs and sequence suggestions
- The list of optional questions, similarly organized
- Follow-up trigger definitions for each question (the LLM evaluates these — see conversation-protocol-spec-v3.md Section 6)
- Instructions on follow-up behavior: "After each answer, evaluate the follow-up triggers for that question based on your judgment. If trigger conditions are met, ask one of the suggested follow-ups before moving to the next core question."
- Instructions on progression: "Move between different category buckets to maintain conversational variety. Do not cluster all questions from one category together."
- Instructions on deduplication: "Do not ask questions that substantially overlap with questions already asked. If a follow-up covers ground similar to an upcoming required question, you may skip the required question and note it as covered."
- Instructions on missing trigger targets: "If a trigger references a follow-up question that is not in your current question set, skip that trigger."

### Per-Turn State Update

After each response, the application updates and passes back to the LLM:
- List of questions asked so far (IDs and brief text)
- Which category buckets have been covered and which are underrepresented
- Remaining required questions
- Remaining optional questions
- Trigger definitions for the most recently asked question (LLM evaluates against the response)
- Running count of questions asked vs. expected total

**Note:** The per-turn state update does NOT pre-evaluate triggers. Raw trigger definitions are passed to the LLM; the LLM evaluates them.

### LLM Output Capture and Turn Lock

Each LLM turn follows this sequence to ensure accurate snapshot capture and prevent race conditions:

1. **Lock acquisition:** Before initiating the LLM call, the backend sets `is_streaming = true` and `current_turn_llm_text = ""` in the Redis session. This activates the atomic turn lock — any `submitResponse`, `skipQuestion`, or `saveDraft` calls for this interview are rejected while the lock is held.

2. **Streaming with accumulation:** As the LLM streams tokens via SSE to the client, the backend simultaneously accumulates the full completion text into `current_turn_llm_text` in the Redis session. This happens token-by-token or in small batches, ensuring the cached text matches exactly what the client receives.

3. **Stream completion:** When the final token is received (SSE stream closes), the backend sets `is_streaming = false`. The `current_turn_llm_text` now contains the exact, complete text the LLM delivered to the user — including any rephrasing, adaptation, or conversational framing the LLM applied to the template question.

4. **Snapshot on submit:** When `submitResponse` is called, the backend reads `current_turn_llm_text` from the Redis session and writes it as `question_text_as_asked` on the `interview_responses` record. This ensures the snapshot reflects the LLM's actual output, not the original template wording.

5. **Error recovery:** If the LLM call fails or the SSE stream errors, the backend clears `is_streaming = false` and sets `current_turn_llm_text = null`. See conversation-protocol-spec-v3.md Section 15 for the full error recovery protocol.

### Per-Turn Cost Capture

After each LLM call, the backend captures cost-relevant metrics from the Claude API response and writes them to the `interview_responses` record and increments the `interviews` summary counters:

1. **LLM metrics:** `llm_prompt_tokens` and `llm_completion_tokens` from the Claude API `usage` field, `llm_model` from the request, `llm_latency_ms` measured as wall-clock time from request to last streamed token.
2. **STT metrics:** `stt_duration_billed_seconds` from the duration of audio sent to ElevenLabs STT for this response (reported by the STT proxy).
3. **TTS metrics:** `tts_characters_billed` from the character count of the LLM response text sent to ElevenLabs TTS (tracked by the frontend and reported back via `submitResponse` or a separate endpoint).

The cleaning pipeline also records its LLM usage: when `updateCleanedContent` is called, the cleaning Lambda includes the token counts from the cleaning LLM call, which are added to the interview's totals.

### Interview State Storage

During an active interview, session state lives in Redis (ElastiCache). This holds: current question index, conversation history for LLM context, which questions have been asked, which follow-ups have been triggered, the in-progress transcript being assembled from the live STT stream, the `is_streaming` turn lock flag, and the `current_turn_llm_text` accumulator for the active LLM turn. If the session drops, state is reconstructable from the `interview_responses` table. The database is the source of truth for interview progress, not the LLM's conversation memory.

For the complete runtime conversation protocol including message sequences, the frontend state machine, pause/resume, and inactivity handling, see `conversation-protocol-spec-v3.md`.

---

## 10. Admin Interface Specifications

### Template Management Workflow

**Step 1: Template Creation**
- Admin creates a new template with name and description
- Template starts in 'draft' status
- Admin can edit name, description, and status at any time

**Step 2: Question Selection and Ordering**
- Admin sees the question bank with search and tag-based filtering
- **Only active questions** appear (`is_active = true`)
- Multi-select interface to pick questions for the template
- Selected questions appear in an orderable list with drag-and-drop reordering
- Each selected question shows its master category and tags for reference

**Step 3: Category Bucketing**
- Admin assigns each selected question to a category bucket within this template
- Category bucket may differ from the question's master category
- Interface shows questions grouped by bucket with counts per bucket
- Single bucket assignment per question per template

**Step 4: Follow-Up Configuration**
- Admin selects a question and opens a follow-up configuration panel
- Interface shows trigger type options: keyword, sentiment, length, always
- For keyword triggers: text input for keywords/phrases (guidance to the LLM, not exact matching rules)
- For sentiment triggers: dropdown for positive/negative/neutral
- For length triggers: threshold description (the LLM judges, not an exact word count)
- For all triggers: multi-select of other questions in this template as suggested follow-ups
- Multiple triggers can be added per question

**Step 5: Required vs. Optional**
- Toggle per question: required (must be asked) vs. optional (LLM's discretion)
- Interface shows counts of required and optional questions

**Step 6: Preview**
- Collapsible outline view showing the full interview flow
- Each question shows its bucket, required/optional status, and follow-up triggers beneath it
- Follow-up triggers show their conditions and target questions
- Read-only validation view before publishing

**Step 7: Publishing**
- Admin publishes the template, changing status from 'draft' to 'published'
- **Publishing fails if the template has zero questions** (INVALID_STATE error)
- Only published templates can be assigned to users
- Published templates can be edited (updated_at tracks changes) or archived

### Tag Management Interface

- CRUD interface for tags with label and type
- Controlled vocabulary: administrators create tags from defined types, no freeform creation
- **Duplicate detection:** warn if a tag with a similar label already exists; fail with DUPLICATE_ENTRY on exact match
- Usage display: show how many questions and users are associated with each tag
- **Active/inactive toggle:** deactivating a tag shows a warning if it's used in published templates
- **Filter:** show/hide inactive tags (default: hide)

### Question Management Interface

- CRUD interface for questions with text, category, and tag associations
- **Active/inactive toggle:** deactivating a question shows a warning if it's in published templates
- **Filter:** show/hide inactive questions (default: hide)

### User Assignment Interface

- List of users with their current template assignments (from user_templates) and role
- Assign one or more templates to a user via multi-select of **published** templates only
- **Removal is blocked if the user has an in_progress or paused interview for that template.** The UI displays the blocking reason with interview details: interview ID, status, when it started, elapsed duration, and percentage of questions answered. Other template assignments for the same user are unaffected.
- Bulk assignment: select multiple users and assign the same template (users who already have that assignment are skipped with individual messages)
- Show user's tags alongside their assignments for verification
- View assignment history for any user
- View each user's interview status per assigned template (not started, in progress, paused, completed)

### Audit Log Interface (Admin Only)

- Searchable, paginated log of all administrative actions
- Filterable by: actor (admin user), entity type (tag, question, template, user), entity ID, date range
- Each entry shows: timestamp, admin name, action performed, entity affected, and a summary of changes
- Read-only — no editing or deletion of audit log entries

### Interview Cost Dashboard (Admin Only)

- Per-interview cost breakdown: LLM tokens, STT duration, TTS characters
- Per-user aggregation across all interviews
- Sortable by cost metrics to identify outliers

---

## 11. Post-Interview Cleaning Pipeline

### Pipeline Architecture

1. `completeInterview` mutation fires `interview.completed` EventBridge event
2. EventBridge routes to SQS (`InterviewCleaningQueue`)
3. SQS message contains the interview ID
4. Cleaning Lambda picks up the message, fetches all responses for that interview
5. For each response with `raw_transcription` and `processing_status = 'pending'`:
   - Set `processing_status` to 'cleaning'
   - Call the Claude API with the raw transcription and a cleaning prompt
   - Cleaning prompt instructions: remove filler words, fix grammar, structure into coherent paragraphs, preserve the interviewee's voice and meaning
   - Capture token usage from the Claude API response
   - Write `cleaned_markdown`, `cleaning_model`, and `cleaned_at` to the response
   - Update `llm_prompt_tokens` and `llm_completion_tokens` on the response (cleaning call metrics)
   - Increment interview-level cost totals (`total_llm_prompt_tokens`, `total_llm_completion_tokens`)
   - Set `processing_status` to 'cleaned'
6. If cleaning fails for a response: set `processing_status` to 'error', write the failure reason to `error_message`, log to ClickHouse (with `CLEANING_PIPELINE_ERROR_RATE` alert if >10% failure rate), continue with remaining responses
7. SQS dead letter queue for messages that fail 3 times (emits `CLEANING_PIPELINE_DLQ` alert)

### Cleaning Pipeline Trigger

The **sole trigger** is the EventBridge event from `completeInterview`. There is no S3-based trigger. The cleaning pipeline processes `raw_transcription` text, not audio files. Audio upload status is irrelevant to cleaning.

---

## 12. Reconciliation and Background Jobs

All reconciliation tasks run in a **single Lambda function** triggered by an **EventBridge scheduled rule** (every 15 minutes). Defined in the Compute Stack CDK.

**Scan 1: Stuck Cleaning States and Turn Locks**
- Query A: `interview_responses` where `processing_status = 'cleaning'` and `responded_at` older than 10 minutes
- Action: Reset `processing_status` to 'pending' for retry
- Alert: Emit `STUCK_CLEANING_BATCH` if >10 records found
- Query B: Redis sessions where `is_streaming = true` for longer than 60 seconds (checked by scanning active interview sessions in Redis)
- Action: Reset `is_streaming = false` and `current_turn_llm_text = null` to unlock the session
- Alert: Emit `TURN_LOCK_STUCK` for each reset session

**Scan 2: Audio Upload Inconsistencies**
- Query A: `interview_responses` where `input_mode = 'voice'` and `audio_upload_status = 'pending'` and `responded_at` older than 1 hour → flag for admin review
- Query B: Records where `audio_upload_status = 'failed'` → log for admin dashboard
- Query C: Orphaned S3 objects not matching any DB record → tag for lifecycle cleanup
- Alert: Emit `AUDIO_UPLOAD_FAILURE_BATCH` if >5 failed uploads found

**Scan 3: Paused Interview Auto-Abandonment**
- Query: `interviews` where `status = 'paused'` and `paused_at` older than 72 hours
- Action: Set `status = 'abandoned'`, fire `interview.abandoned` EventBridge event
- Alert: Emit `INTERVIEW_ABANDONED_AUTO` for each abandoned interview

**Scan 4: Data Retention Enforcement**
- Query: Records past their configured retention period (see Section 20)
- Action: Execute retention policy (anonymize or delete per configuration)

**CDK definition:**
- Runtime: Node.js 20
- Timeout: 5 minutes
- Environment variables: DATABASE_URL from Secrets Manager, REDIS_URL from Secrets Manager
- IAM role: read/write RDS, list S3 objects in interview audio prefix, delete S3 objects for retention enforcement, read/write ElastiCache Redis
- EventBridge scheduled rule: `rate(15 minutes)`

**Error handling:** If the reconciliation Lambda itself errors, emit `RECONCILIATION_SCAN_FAILURE` alert before rethrowing.

---

## 13. AWS Service Mapping

| Component | AWS Service | Notes |
|---|---|---|
| Database | RDS PostgreSQL | Single instance for dev, Multi-AZ for production |
| Audio storage | S3 | Per-response segments with lifecycle policies per prefix |
| API server | ECS Fargate | **Fastify** with Apollo Server, behind ALB |
| Live STT streaming | ECS Fargate | Authenticated WebSocket proxy to ElevenLabs STT API |
| Frontend hosting | ECS Fargate | Next.js in Docker, same ECS cluster, behind shared ALB |
| Async processing queue | SQS | Cleaning pipeline + dead letter queue |
| Event orchestration | EventBridge | Interview events + scheduled reconciliation (rate 15 min) |
| LLM cleaning | Lambda (Node.js 20) | Claude API for markdown generation |
| User sync | Lambda (Node.js 20) | Cognito post-confirmation trigger |
| Reconciliation | Lambda (Node.js 20) | Stuck cleaning + turn locks + audio uploads + auto-abandonment + data retention |
| Interview session state | ElastiCache Redis | Ephemeral state during active interviews |
| Authentication | Cognito | Admin-invite-only, admin + user groups, JWT validation |
| Observability | ClickHouse Cloud | All telemetry via OTel SDK and Collector |
| Secrets | Secrets Manager | `arena/claude-api-key`, `arena/elevenlabs-api-key`, RDS connection string |

---

## 14. Local Development Environment

### docker-compose.yml

The local development environment runs Postgres and Redis via Docker Compose. All other services are mocked or run locally.

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: arena
      POSTGRES_PASSWORD: arena_local
      POSTGRES_DB: arena_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### Environment Variable Defaults (.env.local)

```
DATABASE_URL=postgresql://arena:arena_local@localhost:5432/arena_dev
REDIS_URL=redis://localhost:6379
COGNITO_BYPASS=true
COGNITO_MOCK_USER_ID=00000000-0000-0000-0000-000000000001
COGNITO_MOCK_GROUPS=admin
ELEVENLABS_MOCK=true
CLAUDE_API_KEY=<real key for LLM testing, or "mock" for deterministic responses>
OTEL_EXPORTER_OTLP_ENDPOINT=<ClickHouse Cloud endpoint, or omit for local-only logging>
ELEVENLABS_API_KEY=<real key for STT/TTS testing, or "mock">
ELEVENLABS_DEFAULT_VOICE_ID=<voice ID from ElevenLabs>
CONSENT_BYPASS=true
COST_THRESHOLD_INTERVIEW_TOKENS=500000
```

### Service Mocks

**Cognito bypass:** When `COGNITO_BYPASS=true`, the JWT validation middleware skips token verification and injects a mock user with the ID and groups from environment variables. Toggle `COGNITO_MOCK_GROUPS` between `admin` and `user` to test different roles.

**Consent bypass:** When `CONSENT_BYPASS=true`, the consent check in `startInterview` is skipped. This allows local development without going through the consent flow. Set to `false` to test the consent workflow locally.

**ElevenLabs STT mock:** When `ELEVENLABS_MOCK=true`, the STT WebSocket proxy returns canned transcription responses instead of connecting to ElevenLabs. Returns configurable responses with realistic timing (~300ms delay per partial transcript).

**ElevenLabs TTS mock:** When `ELEVENLABS_MOCK=true`, the TTS token endpoint returns a mock token. The frontend, when detecting a mock token, skips actual TTS API calls and proceeds with text-only display.

**Claude API:** Use the real Claude API key for integration testing. For deterministic unit tests, mock the Claude client at the service layer to return scripted responses.

### Local Development Workflow

1. `docker-compose up -d` — start Postgres and Redis
2. `cd api && npx prisma migrate dev` — run migrations
3. `cd api && npx prisma db seed` — seed test data
4. `cd api && npm run dev` — start Fastify server with hot reload
5. `cd frontend && npm run dev` — start Next.js with hot reload
6. API available at `http://localhost:3001/graphql`
7. Frontend available at `http://localhost:3000`

---

## 15. Testing Strategy

### Framework: Vitest

Vitest is used for all tests: unit, integration, and end-to-end. It provides native ESM and TypeScript support without additional configuration.

### Test Layers

**Unit tests (fast, no external dependencies):**
- GraphQL resolvers: test input validation, error codes, business rule enforcement
- Service layer: test interview state management, template loading, trigger formatting
- Utility functions: test PII scrubbing, pagination cursor encoding/decoding
- Prisma audit middleware: test that audit log entries are created for admin mutations
- Turn lock enforcement: test that `submitResponse`, `skipQuestion`, and `saveDraft` are rejected when `is_streaming = true`

**Integration tests (require database):**
- Prisma operations: test complex queries, pagination, cascading behaviors
- Full resolver → database round trips
- Run against the local Docker Compose Postgres instance
- Use Prisma's test utilities for database cleanup between tests
- Admin audit log: verify entries are written in same transaction as mutations
- User-template assignment: test multi-template assignment, removal blocking, concurrent interview constraints

**Interview engine tests (require Redis + database):**
- Session initialization and state management
- Turn lock lifecycle: verify `is_streaming` flag set/cleared correctly, verify `current_turn_llm_text` accumulation
- `question_text_as_asked` snapshot accuracy: verify that adapted LLM text (not template text) is captured
- Pause/resume state reconstruction
- Full question flow with mock LLM responses
- Consent verification before interview start
- Cost metric capture from mock LLM/STT responses
- Race condition test: verify `submitResponse` rejected during active stream

**End-to-end tests (require all services):**
- Full interview flow: start → respond → complete → cleaning pipeline
- Multi-template user flow: assign multiple templates → start interview for one → complete → start interview for another
- Audio upload flow (with mock STT)
- Admin workflows: create template → assign → run interview
- Consent flow: grant consent → start interview; revoke consent → blocked from starting

### Load Testing (Pre-Production)

Before production launch, run a load test to validate concurrency targets defined in Section 21. Use a tool such as k6 or Artillery to simulate concurrent interview sessions hitting the Fastify API, Redis, and RDS. The load test should cover: concurrent `startInterview` calls, concurrent SSE streams for LLM responses, concurrent WebSocket STT connections, and concurrent `submitResponse` writes. Results should be compared against the latency budgets in Section 21 and infrastructure should be right-sized accordingly.

### Test Data

The Prisma seed script (`api/prisma/seed.ts`) creates a standard test dataset:
- 5 tags (mixed types)
- 10 questions with tag associations (mix of active and inactive)
- 2 templates: one with 6 ordered questions including follow-up triggers, one with 4 questions (for multi-template testing)
- 1 admin user and 2 standard users with tags, roles, and template assignments (one user assigned both templates, one user assigned one template)
- Consent records for the standard users (all consent types granted)

### Running Tests

```bash
cd api && npm run test          # unit tests
cd api && npm run test:int      # integration tests (requires docker-compose up)
cd api && npm run test:e2e      # end-to-end tests (requires all services)
cd api && npm run test:coverage # coverage report
```

---

## 16. Implementation Priority

### Phase 0: Local Environment Setup

1. Create `docker-compose.yml` with Postgres 15 and Redis 7
2. Initialize project structure: CDK app in `/infrastructure`, Fastify API in `/api`, Next.js in `/frontend`
3. Configure `.env.local` with mock defaults
4. Set up Vitest configuration in `/api`
5. Create minimal stub Dockerfiles for API and frontend (just enough to build — health check endpoints returning 200)

### Phase 1: Foundation Infrastructure (CDK)

1. **Foundation Stack:** VPC with public/private subnets (2 AZs), security groups, ALB with HTTPS listener, Cognito user pool (admin-invite-only, admin + user groups), ECR repositories, post-confirmation Lambda for user sync (including role column)
2. **Data Stack:** RDS PostgreSQL (db.t3.micro for dev), ElastiCache Redis (cache.t3.micro for dev), S3 bucket with lifecycle policies per prefix (responses/ and drafts/), Secrets Manager secrets (`arena/claude-api-key`, `arena/elevenlabs-api-key`, RDS connection string)
3. **Compute Stack:** ECS cluster, API Fargate service with **placeholder nginx image** (real image deployed after Phase 4), frontend Fargate service with **placeholder nginx image**, ALB routing (/api/* and /graphql → API, everything else → frontend), cleaning Lambda, reconciliation Lambda (EventBridge rate 15 min), SQS queues (cleaning + DLQ), EventBridge rules

**Verify:** All stacks deploy successfully. Placeholder services pass ALB health checks. Cognito pool exists with correct groups. Secrets exist in Secrets Manager.

### Phase 2: Data Layer

1. Define Prisma schema matching all tables in the Data Model section — including `user_templates`, `response_drafts`, `template_assignment_history`, `user_consent_records`, `admin_audit_log`, `role` column on `users`, cost fields on `interview_responses` and `interviews`, all CHECK constraints, and all composite indexes
2. Run migrations against local Postgres
3. Write seed script with test data (including consent records, role values, and multi-template assignments)
4. Write unit tests for seed data integrity

**Verify:** Migrations succeed. Seed runs. `prisma studio` shows correct data and relationships. Tests pass.

### Phase 3: GraphQL API — Core CRUD

1. Stand up Fastify server with Apollo Server plugin
2. Implement Cognito JWT validation middleware (with bypass for local dev)
3. Implement OTel auto-instrumentation, error logging to ClickHouse, and structured alert events
4. Implement standard error handling pattern (typed error codes via extensions)
5. Implement Prisma audit middleware for admin mutations → `admin_audit_log`
6. Implement tag CRUD mutations and queries (with soft-delete, duplicate detection)
7. Implement question CRUD mutations and queries (with tag associations, soft-delete, pagination)
8. Implement template CRUD mutations and queries (with template_questions, ordering, triggers, publish validation)
9. Implement user queries and template assignment via `user_templates` (assign, remove with active/paused interview blocking check per template)
10. Implement `getMyAssignedTemplates` query
11. Implement `syncUserRole` mutation
12. Implement consent mutations (`grantConsent`, `revokeConsent`) and `getMyConsentStatus` query
13. Implement `getAuditLog` query (admin only, paginated, filterable)
14. Set up DataLoader for batched relation resolution
15. Write unit tests for every resolver's happy path and error cases, including audit log verification

**Verify:** Run API locally. Test all CRUD operations via Apollo Sandbox. Verify error codes on business rule violations. Verify template removal is blocked during active/paused interviews for that template. Verify audit log entries are created for all admin mutations. Tests pass.

### Phase 4: Interview Engine

**Task 4a: Redis Session Management + Start Interview**
1. Implement Redis session initialization (session structure per conversation-protocol-spec-v3.md Section 5, plus `is_streaming` flag and `current_turn_llm_text` accumulator)
2. Implement `startInterview(templateId)` mutation — derives user from JWT, verifies consent, verifies active assignment for specified template, creates interview record, initializes Redis session. Fails if user has an in_progress interview for any template.
3. Implement `pauseInterview` and `resumeInterview` mutations with session snapshot/restore
4. Write integration tests for session lifecycle

**Task 4b: WebSocket STT Proxy**
1. Build authenticated WebSocket endpoint on Fastify (JWT validation per conversation-protocol-spec-v3.md Section 12)
2. Implement ElevenLabs STT proxy — audio_start/audio_chunk/audio_end message types
3. Build progressive transcript assembly in Redis
4. Build mock STT for local dev
5. Write integration tests for STT flow with mock

**Task 4c: LLM Orchestration**
1. Build the LLM system prompt constructor (template → system prompt with trigger definitions)
2. Build SSE streaming endpoint for LLM responses with concurrent accumulation of `current_turn_llm_text` in Redis
3. Implement atomic turn lock: set `is_streaming = true` before LLM call, clear on stream completion or error
4. Build the per-turn state manager (question tracking, bucket coverage)
5. Implement per-turn cost capture (LLM tokens, STT duration, TTS characters → `interview_responses` + `interviews` totals)
6. Implement `submitResponse` mutation — frontend sends only `rawTranscription` and `inputMode`; backend derives all other fields from Redis session state including `questionTextAsAsked` from `current_turn_llm_text`. Rejected if `is_streaming = true`.
7. Implement `skipQuestion` mutation — backend derives active question from Redis session state. Rejected if `is_streaming = true`.
8. Implement `completeInterview` mutation (flush Redis, update user_templates assignment status, fire EventBridge)
9. Build inactivity timer and heartbeat handling
10. Implement `COST_THRESHOLD_INTERVIEW` alert when interview exceeds configurable token threshold
11. Write integration tests for full interview flow with mock LLM, including cost metric verification, turn lock enforcement, and `question_text_as_asked` snapshot accuracy

**Verify:** Full interview flow works locally: start → respond (voice and text) → skip → pause → resume → complete. Redis session state is correct throughout. Turn lock prevents submission during streaming. `question_text_as_asked` captures LLM's actual output. Consent check works. Active interview blocking works across templates. Cost metrics are captured. Tests pass.

### Phase 5: Post-Interview Pipeline

1. Implement presigned URL mutations for audio upload (`requestResponseAudioUploadUrl`, `requestDraftAudioUploadUrl`)
2. Implement `confirmAudioUpload` and `confirmDraftAudioUpload` mutations
3. Implement `saveDraft` mutation — frontend sends only `content`, `inputMode`, and `sttConfidenceScore`; backend derives `questionId` from Redis session state. Rejected if `is_streaming = true`.
4. Build cleaning Lambda (Claude API for markdown generation, error handling with `error_message`, cost capture for cleaning LLM calls, alert emission)
5. Implement `updateCleanedContent` mutation
6. Build reconciliation Lambda (five scans: stuck cleaning + turn locks, audio uploads, auto-abandonment, data retention) with alert emission
7. Write tests for cleaning pipeline with mock Claude API

**Verify:** Manually publish test message to SQS. Cleaning Lambda processes responses. Reconciliation Lambda runs without errors, including turn lock cleanup. Alerts are emitted correctly. Tests pass.

### Phase 6: Admin Interface

1. Cognito authentication flow (login page, session management)
2. Tag management page (CRUD, soft-delete toggle, usage counts, duplicate warning)
3. Question bank page (list with pagination, tag filtering, search, soft-delete toggle)
4. Template builder (question selection, drag-and-drop ordering, bucketing, follow-up trigger configuration, required/optional toggle, preview, publish with zero-question validation)
5. User management (list users with roles and all assigned templates, assign/remove templates with active/paused interview blocking per template, bulk assignment, view assignment history, sync role, view per-template interview status)
6. Audit log page (searchable, filterable, paginated)
7. Interview cost dashboard (per-interview breakdown, per-user aggregation)

**Verify:** Full admin workflow works via UI: create tags → create questions → build template → publish → assign to user (including multiple templates to same user). Template removal blocked for users with active interviews for that template. Audit log shows all actions. Cost dashboard shows metrics.

### Phase 7: Interview Frontend

1. Interview landing page (user sees all assigned templates with interview status for each, start button per template, consent collection if not yet granted)
2. Consent collection UI — data processing disclosure with checkboxes for each consent type, must be completed before first interview
3. Full frontend state machine (per conversation-protocol-spec-v3.md Section 3), including turn lock awareness — disable submission controls while LLM is streaming
4. Push-to-talk with MediaRecorder + STT WebSocket
5. Text input alternative
6. LLM response streaming via SSE + TTS playback
7. Redo/draft flow with silent draft saving
8. Skip, pause, resume, end interview flows
9. Background audio upload queue
10. Progress bar and hybrid layout
11. Error handling and recovery (per conversation-protocol-spec-v3.md Section 15), including turn lock error handling (retry after lock clears)

**Verify:** Full end-to-end test: log in → grant consent → see multiple assigned templates → start interview for one → respond via voice and text → redo → skip → pause → resume → complete → start interview for another template → verify audio in S3 → watch cleaning process responses.

### Phase 8: Dockerize and Deploy

1. Create production Dockerfiles for API and frontend (multi-stage builds)
2. Build images and push to ECR
3. Update Fargate services to pull real images (replacing placeholders)
4. Run Prisma migrations on the RDS instance
5. Verify both services pass ALB health checks
6. Test full flow in deployed environment

### Phase 9: Load Test and Right-Size

1. Run load test against deployed environment simulating target concurrent interviews (see Section 21)
2. Measure LLM TTFT, SSE stream latency, WebSocket STT latency, database query times
3. Compare against latency budgets in Section 21
4. Right-size RDS, ElastiCache, and Fargate task counts based on results
5. Document results and any infrastructure changes

### Phase 10: CI/CD Pipeline (Optional)

1. GitHub Actions: build + push Docker images on push to main
2. Run Prisma migrations as part of API deployment
3. Run test suite before deploy
4. CDK diff on infrastructure changes

---

## 17. Operational Guidance

### CDK Deployment Failures

- If `cdk deploy` fails partway through, CloudFormation will attempt to rollback automatically
- If rollback succeeds: fix the issue in code and re-deploy
- If rollback fails (ROLLBACK_FAILED state): use `cdk destroy <StackName>` to clean up, then re-deploy from scratch
- For stacks with stateful resources (Data Stack — RDS, S3): be cautious with `cdk destroy` as it will delete data. Consider using CloudFormation stack policies to protect stateful resources.
- If RDS is created but security group rules are wrong: update the CDK code and `cdk deploy` again — CloudFormation will update in-place
- Always deploy stacks in dependency order: Foundation → Data → Compute

### Secrets Management

- Never hardcode API keys in application code or environment variables
- All secrets live in AWS Secrets Manager and are injected at runtime
- Rotate keys by updating the secret value in Secrets Manager and restarting the Fargate tasks
- For local dev: use `.env.local` (never committed to git)

### Database Migrations

- Always run `npx prisma migrate dev` locally before deploying
- For production: run migrations as part of the API container startup or as a separate migration job
- Never modify a migration file after it has been applied — create a new migration instead

---

## 18. Open Questions (Deferred)

- **Template versioning**: Immutable snapshots when a template is published, with version tracking. For v1, rely on updated_at timestamps and the snapshot approach on responses.
- **Tag hierarchy**: Parent-child tag relationships via self-referential foreign key. Flat tags are sufficient for v1.
- **Conditional branching**: DAG-style routing where question selection depends on specific answer content. Follow-up triggers provide soft routing for v1.
- **Learned sequencing**: Optimization of question ordering based on historical response quality. Requires historical data.
- **GraphQL subscriptions**: Real-time processing status updates. Polling is acceptable for v1.
- **pgvector integration**: Embedding storage and semantic search across interview responses.
- **Interview duration management**: Logic to enforce a maximum number of questions or time limit per interview. For v1, rely on the LLM's judgment and the bounded question set.
- **Configurable TTS voice**: Per-engagement or per-template voice selection for ElevenLabs TTS.
- **Cross-engagement agent queue**: Arena AI team managing multiple client instances.
- **Multi-tenancy / engagement isolation**: Threading an `engagement_id` or `client_id` through the data model to isolate data across different consulting engagements or clients. For v1, all data lives in a single flat namespace.
- **Cost-based rate limiting**: Per-user or per-template cost caps that pause or block interviews when exceeded. For v1, cost tracking is observational with alerts (see `COST_THRESHOLD_INTERVIEW` alert).
- **Concurrent active interview limit increase**: Currently capped at one `in_progress` interview per user. Future versions may allow multiple simultaneous active interviews if the resource contention concern is addressed.

---

## 19. Constraints and Guardrails

- **Single Postgres transaction for response writes.** Never split a response write across multiple uncommitted operations.
- **Snapshots are the source of truth for historical data.** Never rely on joining back to master question records for interview analysis. The `question_text_as_asked` field captures the LLM's actual delivered text, not the template original.
- **The LLM works from a bounded question set.** Never pass the entire question bank into the interview prompt. Always pre-curate via the template.
- **Audio binary data never routes through GraphQL.** Always use presigned S3 URLs for upload.
- **Tags are a controlled vocabulary.** No freeform tag creation by non-administrators.
- **Never hard-delete master data under normal operation.** Tags, questions, and templates are deactivated or archived, never deleted. Data subject deletion requests follow the process in Section 20.
- **All database access goes through Prisma.** No raw SQL unless Prisma's query builder cannot express the operation.
- **Cognito is the sole authentication provider.** All API requests must include a valid Cognito JWT (except in local dev with bypass enabled). User IDs correspond to Cognito sub claims.
- **Live STT is handled by Fargate, not Lambda.** The WebSocket streaming pattern requires a persistent connection.
- **Redis is ephemeral.** Interview session state in Redis is a performance optimization. The database is always the source of truth. If Redis data is lost, state is reconstructable from interview_responses.
- **API keys are stored in AWS Secrets Manager.** `arena/claude-api-key` and `arena/elevenlabs-api-key`. Never hardcode.
- **No PII in telemetry.** ClickHouse receives UUIDs, error codes, stack traces, metrics, and timestamps. Never names, emails, transcriptions, or content.
- **The LLM evaluates follow-up triggers.** No application-side keyword matching, sentiment analysis, or word counting for trigger evaluation.
- **All errors use typed error codes.** Every GraphQL error includes an `extensions.code` from the standard vocabulary.
- **Fastify is the backend framework.** Not Express. This is decided.
- **Interview mutations derive state from the backend.** `startInterview` uses the authenticated user's JWT identity. `submitResponse`, `skipQuestion`, and `saveDraft` derive question context from the Redis session state — including `questionTextAsAsked` from the LLM's cached output. The frontend never sends metadata that the backend can determine from its own authoritative state.
- **Consent is required before interviews.** Users must grant all required consent types before starting an interview. The `startInterview` mutation enforces this.
- **Template removal is blocked during active interviews for that template.** A user with an `in_progress` or `paused` interview for a specific template cannot have that template assignment removed. Other template assignments are unaffected.
- **One active interview at a time per user.** A user may have at most one interview with `status = 'in_progress'` across all templates. Multiple `paused` interviews are allowed.
- **All admin mutations are audit-logged.** Prisma middleware writes to `admin_audit_log` in the same transaction as every admin mutation. The audit log is append-only.
- **Cost metrics are captured per turn.** Every LLM call, STT session, and TTS generation records its cost-relevant metrics on the response record and increments interview totals.
- **Atomic turn lock prevents race conditions.** The `is_streaming` Redis flag blocks `submitResponse`, `skipQuestion`, and `saveDraft` while the LLM is streaming a response. The backend is the authoritative enforcer; the frontend disables controls as a UX convenience.
- **LLM output is cached for snapshot accuracy.** The `current_turn_llm_text` Redis field accumulates the full LLM completion during SSE streaming. This cached text — not the original template question — becomes the `question_text_as_asked` snapshot.

---

## 20. Data Privacy, Consent, and Retention

### Consent Collection

The platform records voice audio and processes responses through AI models. Before participating in any interview, users must grant informed consent for each of the following:

- **`data_processing`**: Consent to have their interview responses (text and transcriptions) stored and processed.
- **`audio_recording`**: Consent to have their voice recorded, stored in S3, and transcribed via a third-party STT service (ElevenLabs).
- **`ai_interaction`**: Consent to interact with an AI interviewer (LLM) and have their responses processed by AI models for transcription cleaning.

### Consent Workflow

1. **First login**: After authenticating via Cognito, the frontend checks the user's consent status via `getMyConsentStatus`. If any required consent type is missing, the user is directed to the consent collection screen before they can access the interview landing page.
2. **Consent collection screen**: Displays a clear, plain-language disclosure for each consent type explaining what data is collected, how it is used, who processes it (including third-party services), and how long it is retained. Each consent type has an individual checkbox. The user must check all three and click "I Agree" to proceed. The consent version string (e.g., `"v1.0"`) is displayed and recorded.
3. **Recording consent**: Each checkbox acceptance calls `grantConsent(consentType, consentVersion)`, which inserts a row in `user_consent_records` with the timestamp and IP address.
4. **Interview gate**: The `startInterview` mutation checks that all three consent types are granted (active, non-revoked records exist in `user_consent_records`). If any are missing, it returns a `CONSENT_REQUIRED` error.
5. **Consent version changes**: When consent text is updated (new `consent_version`), users with only the old version are prompted to re-consent on their next login. Interviews cannot start until the current version is granted.

### Data Retention

Audio files and interview data are subject to configurable retention policies:

- **Audio files (S3)**: Default retention of 365 days from interview completion. Enforced via S3 lifecycle policies on the `responses/` and `drafts/` prefixes, supplemented by the reconciliation Lambda (Scan 4) for records requiring database cleanup.
- **Interview responses and transcriptions**: Retained for the duration of the engagement plus 90 days. After retention expiry, `raw_transcription` and `cleaned_markdown` fields are set to `'[REDACTED — RETENTION EXPIRED]'` and audio S3 objects are deleted. The response record itself (metadata, timestamps, question text snapshot) is preserved for audit purposes.
- **Retention configuration**: Retention periods are configured via environment variables (`AUDIO_RETENTION_DAYS`, `TRANSCRIPTION_RETENTION_DAYS`) with sensible defaults. These can be overridden per deployment.

### Right to Deletion (Data Subject Requests)

Users can request deletion of their personal data via the `requestDataDeletion` mutation or by contacting an administrator.

**Deletion workflow:**
1. The `requestDataDeletion` mutation creates a deletion request record and fires a `data.deletion_requested` EventBridge event.
2. An admin reviews and approves the request (v1: manual approval via admin interface).
3. Upon approval, a Lambda function executes the deletion:
   - All `interview_responses` for the user: `raw_transcription` and `cleaned_markdown` set to `'[DELETED — DATA SUBJECT REQUEST]'`. Audio S3 objects are deleted.
   - All `response_drafts` for the user: `content` set to `'[DELETED]'`. Audio S3 objects are deleted.
   - The `users` record: `name` set to `'[DELETED]'`, `email` set to a unique anonymized value (e.g., `deleted-{uuid}@redacted.local`).
   - User tags (`user_tags`) are removed.
   - User template assignments (`user_templates`) are removed.
   - The Cognito account is disabled (not deleted — prevents re-registration with the same email during the retention window).
4. Interview metadata (timestamps, question snapshots, sequence numbers) and template associations are preserved for research integrity, but all PII and user-generated content is removed.
5. The deletion is logged to ClickHouse (UUID only, no PII) for audit purposes.

### Data Processing Disclosure

The login page and consent screen must include a link to a data processing disclosure document that covers: what data is collected, the legal basis for processing, third-party processors (ElevenLabs for STT/TTS, Anthropic for LLM), data storage location (AWS region), retention periods, and how to exercise data subject rights. This document is maintained as static content in the frontend and versioned alongside consent versions.

---

## 21. Performance Budgets and Scalability Targets

### Concurrency Target

The v1 platform targets **20 concurrent active interview sessions**. An "active session" is an interview with `status = 'in_progress'` where the user is actively responding — generating LLM calls, STT streams, and TTS requests simultaneously.

This target informs infrastructure sizing for dev and initial production:

| Resource | Dev Sizing | Production Sizing (20 concurrent) |
|---|---|---|
| RDS PostgreSQL | db.t3.micro | db.t3.medium (2 vCPU, 4GB RAM), Multi-AZ |
| ElastiCache Redis | cache.t3.micro | cache.t3.small (1 vCPU, 1.5GB RAM) |
| API Fargate | 0.5 vCPU, 1GB | 1 vCPU, 2GB, min 2 tasks, max 4 tasks (auto-scaling on CPU) |
| Frontend Fargate | 0.25 vCPU, 0.5GB | 0.5 vCPU, 1GB, min 2 tasks |
| Prisma connection pool | 5 connections | 20 connections per task |

These are starting points. Phase 9 (Load Test and Right-Size) validates them before production launch and adjusts as needed.

### Latency Budgets

| Operation | Budget | Alert Threshold | Notes |
|---|---|---|---|
| LLM time-to-first-token (TTFT) | ≤2000ms (p95) | 3000ms | Measured from SSE request to first streamed token. Dependent on Claude API performance. |
| LLM full response | ≤8000ms (p95) | 12000ms | Full streamed response including all tokens. |
| STT partial transcript | ≤500ms (p95) | 1000ms | From audio chunk receipt at Fargate to partial transcript returned to client. Includes ElevenLabs round-trip. |
| GraphQL mutation (non-LLM) | ≤200ms (p95) | 500ms | `submitResponse`, `skipQuestion`, `confirmAudioUpload`, etc. Database writes. |
| Presigned URL generation | ≤100ms (p95) | 300ms | S3 presigned URL mutations. |
| SSE event delivery | ≤100ms (p95) | 300ms | From backend emitting event to client receiving it (network-dependent). |
| Page load (admin UI) | ≤2000ms (p95) | 4000ms | Time to interactive for admin pages. |

These budgets are measured via OTel custom spans. The `LLM_TTFT_EXCEEDED` and `EXTERNAL_SERVICE_LATENCY` alerts fire when thresholds are breached (see Section 5).

### Scaling Plan

If concurrent sessions need to exceed 20:
1. **Fargate API tasks**: Auto-scaling already configured. Increase max task count.
2. **RDS**: Upgrade instance class (t3.medium → t3.large → r6g series). Read replicas for admin queries if needed.
3. **ElastiCache**: Upgrade instance class. Redis cluster mode is not needed at this scale.
4. **Prisma connection pool**: Increase pool size proportionally with Fargate tasks. Monitor with `DB_CONNECTION_POOL_EXHAUSTED` alert.
5. **ElevenLabs API**: Check rate limits against concurrent STT/TTS usage. ElevenLabs enterprise tier may be required.
6. **Claude API**: Check rate limits against concurrent LLM calls. Anthropic enterprise tier may be required.

The system is designed so that scaling is primarily a matter of increasing instance sizes and task counts, not architectural changes. The I/O-bound, stateless (Redis-backed) design means horizontal scaling of the API layer is straightforward.