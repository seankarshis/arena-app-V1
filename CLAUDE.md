# Arena — Elastic Horizon Interview Platform

## Boundaries

Work only within this repo root. Do not access parent directories or `.env` files outside this directory.

## Naming Conventions

- **elastichorizon**: The company and brand. Used in UI copyright notices, legal references, and public-facing content.
- **Arena**: The internal platform codename. Used in code, repo names, internal docs, and infrastructure resource naming.

## Two Authoritative Specifications

- **`brain/specs/interview-spec-v2.md`** — data model, infrastructure, GraphQL schema, admin UI, cleaning pipeline, observability, auth, testing
- **`brain/specs/conversation-protocol-spec.md`** — runtime conversation behavior, audio architecture, SSE streaming, frontend state machine, interview UI

### Where They Conflict
- **interview-spec-v2.md wins** on data model and schema decisions.
- **conversation-protocol-spec.md wins** on runtime behavior and frontend state.
- **KNOWN CONFLICT — RESOLVED:** conversation-protocol-spec.md Section 8 says to remove the `user_templates` junction table and use a `current_template_id` FK on the users table. **Ignore this.** Use the `user_templates` many-to-many junction table defined in interview-spec-v2.md Section 4. This is the settled decision.
- If you discover a new conflict between the two specs, flag it clearly in your output. Do not guess which one wins — ask for clarification.

### brandStandards.md
Referenced ONLY when building UI components (frontend pages, React components). Never referenced for infrastructure, API, database, or Lambda work.

## Immutable Technical Constraints

These constraints apply to ALL code in this repository. They are non-negotiable.

### Framework Choices (Decided — Do Not Change)
- **Backend: Fastify** — not Express. Fastify is the backend framework. Do not use Express anywhere in the Arena application code.
- **Testing: Vitest** — not Jest. All tests use Vitest. Do not use Jest anywhere.
- **ORM: Prisma** — all database access goes through Prisma. No raw SQL unless Prisma's query builder cannot express the operation.
- **UI Components: shadcn/ui** — built on Radix primitives.
- **GraphQL: Apollo Server** — runs as Fastify plugin via `@as-integrations/fastify`.

### Data Integrity Rules
- **No delete mutations.** `deleteTag`, `deleteQuestion`, and `deleteTemplate` mutations are explicitly prohibited. Use soft-delete instead: `updateTag` with `isActive: false`, `updateQuestion` with `isActive: false`, `updateTemplate` with `status: 'archived'`. Do not create delete mutations under any circumstances.
- **Snapshots are the source of truth for historical data.** Never rely on joining back to master question records for interview analysis. The `question_text_as_asked` field captures the LLM's actual delivered text.
- **Single Postgres transaction for response writes.** Never split a response write across multiple uncommitted operations.
- **Redis is ephemeral.** The database is always the source of truth. If Redis data is lost, state is reconstructable from `interview_responses`.
- **Tags are a controlled vocabulary.** No freeform tag creation by non-administrators.

### Security and Privacy Rules
- **No PII in telemetry.** ClickHouse receives only: UUIDs, error codes, stack traces, metrics, timestamps, model names, counts. NEVER: names, emails, transcription content, question text, audit log changes content.
- **API keys in Secrets Manager only.** `arena/claude-api-key` and `arena/elevenlabs-api-key`. Never hardcode keys in application code.
- **Cognito is the sole auth provider.** All API requests require a valid Cognito JWT (except local dev with bypass). User IDs correspond to Cognito `sub` claims.
- **Audio binary data never routes through GraphQL.** Always use presigned S3 URLs for audio upload.
- **Consent is required before interviews.** The `startInterview` mutation enforces that all required consent types are granted.

### Interview Engine Rules
- **The LLM evaluates follow-up triggers.** No application-side keyword matching, sentiment analysis, or word counting for trigger evaluation. Trigger definitions are passed in the LLM system prompt.
- **The LLM works from a bounded question set.** Never pass the entire question bank into the interview prompt. Always pre-curate via the template.
- **Interview mutations derive state from the backend.** `startInterview` uses the JWT identity. `submitResponse`, `skipQuestion`, `saveDraft` derive question context from Redis session state. The frontend never sends metadata the backend can determine itself.
- **Atomic turn lock prevents race conditions.** The `is_streaming` Redis flag blocks submissions while the LLM is streaming. The backend is the authoritative enforcer.
- **One active interview at a time per user.** A user may have at most one `in_progress` interview across all templates.

### Error Handling
- **All GraphQL errors use typed error codes** via Apollo Server's `extensions.code`. Standard codes: `NOT_FOUND`, `DUPLICATE_ENTRY`, `INVALID_STATE`, `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `EXTERNAL_SERVICE_ERROR`, `RATE_LIMITED`, `CONSENT_REQUIRED`.
- **All admin mutations are audit-logged.** Prisma middleware writes to `admin_audit_log` in the same transaction.

### Cost Tracking
- **Every LLM call, STT session, and TTS generation records cost metrics** on the response record and increments interview totals.

## Brand Standards (UI Work Only)

When building UI components, apply these from `brandStandards.md`:
- Interview UI uses **IBM Plex Sans** (not Space Grotesk — that's hero/campaign only)
- Primary CTA color: `--horizon-red`
- Chat-like panels: `--dark-maroon` background, `--ivory` text
- Input fields: `--ivory-tint` background
- Progress bars: `--horizon-red` fill on `--ivory-tint` background
- Body text: IBM Plex Sans 400, 16-18px

## Local Development

```bash
docker-compose up -d              # Start Postgres + Redis
cd api && npx prisma migrate dev  # Run migrations
cd api && npx prisma db seed      # Seed test data
cd api && npm run dev             # Start Fastify server
cd frontend && npm run dev        # Start Next.js
```

- API: http://localhost:3001/graphql
- Frontend: http://localhost:3000
- When `COGNITO_BYPASS=true`: JWT validation is skipped, mock user injected
- When `ELEVENLABS_MOCK=true`: STT/TTS calls return canned responses
- When `CONSENT_BYPASS=true`: consent check in `startInterview` is skipped

## Current Build State

*Last updated: 2026-04-05. See `brain/architecture/current-state.md` for full detail.*

- **Completed modules:** API (Fastify + Apollo + Prisma, all resolvers), Frontend (Next.js, admin UI, interview UI, all hooks), all three Lambda handlers (cleaning, reconciliation, user-sync), CI/CD pipelines, all three CDK stacks (coded, not yet deployed)
- **In progress:** (nothing active)
- **Schema version:** Migrations exist in `api/prisma/migrations/` — run `npx prisma migrate deploy` against a fresh DB
- **Infrastructure deployed:** EC2 dev environments only (appv1, seandev). CDK stacks coded but never deployed to AWS.
- **Known gaps:** Audio upload via S3 presigned URLs not implemented (schema stubs removed — see `brain/decisions/003`). Frontend test coverage minimal.
- **Next work:** Deploy FoundationStack (Cognito, user-sync Lambda) and DataStack (RDS, ElastiCache) for managed AWS services. Compute stays on EC2/PM2. See `brain/runbooks/cdk-deploy-checklist.md`.