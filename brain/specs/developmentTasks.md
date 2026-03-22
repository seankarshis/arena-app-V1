# Claude Code Implementation Plan (v2)

## Reference Documents

This implementation plan references two companion specification documents. Both are authoritative. If Claude Code makes a decision that conflicts with either spec, the spec wins.

- **`interview-spec-v2.md`** — Data model, technology stack, infrastructure, GraphQL API, admin interface, cleaning pipeline, observability, authentication, local development, testing strategy
- **`conversation-protocol-spec-v3.md`** — Runtime conversation protocol: message sequences, audio architecture, frontend state machine, pause/resume, inactivity handling, SSE message types, UI layout, error recovery during interviews

Read the relevant spec sections **before** starting each task. Task prompts reference sections by title.

---

## Prerequisites

Before starting, ensure the following are in place on your local machine:

- **AWS CLI** installed and configured with credentials that have admin-level permissions
- **Node.js 20+** installed
- **AWS CDK CLI** installed globally (`npm install -g aws-cdk`)
- **Docker** installed and running (needed for local dev environment and building Fargate container images)
- **Claude Code** installed (`npm install -g @anthropic-ai/claude-code`)
- **Git** initialized in your project directory

---

## Project Structure

```
/arena-app
├── CLAUDE.md                          ← Project-wide instructions for Claude Code
├── interview-spec-v2.md               ← Technical specification (data, infra, API, admin)
├── conversation-protocol-spec-v3.md   ← Runtime conversation protocol
├── brandStandards.md                  ← Elastic Horizon brand standards
├── docker-compose.yml                 ← Local dev: Postgres + Redis
├── .env.local                         ← Local dev secrets (never committed to git)
├── infrastructure/
│   ├── bin/
│   │   └── app.ts                     ← CDK app entry point
│   ├── lib/
│   │   ├── foundation-stack.ts        ← Stack 1: VPC, ALB, Cognito, ECR, user sync Lambda
│   │   ├── data-stack.ts              ← Stack 2: RDS, Redis, S3, Secrets Manager
│   │   └── compute-stack.ts           ← Stack 3: ECS, Fargate, Lambda, SQS, EventBridge
│   ├── cdk.json
│   ├── tsconfig.json
│   └── package.json
├── api/
│   ├── src/
│   │   ├── server.ts                  ← Fastify + Apollo Server entry point
│   │   ├── schema/                    ← GraphQL type definitions and resolvers
│   │   ├── services/                  ← Business logic (interview engine, STT proxy, etc.)
│   │   ├── middleware/                ← Cognito JWT validation, error handling, OTel
│   │   ├── websocket/                ← WebSocket handlers for live STT streaming
│   │   ├── sse/                       ← SSE endpoint for LLM response streaming
│   │   └── lambda/                    ← Lambda handlers (cleaning, reconciliation, user-sync)
│   ├── prisma/
│   │   ├── schema.prisma             ← Database schema
│   │   ├── migrations/               ← Generated migration files
│   │   └── seed.ts                   ← Test data seeding
│   ├── vitest.config.ts              ← Test configuration
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── app/                      ← Next.js app router pages
│   │   ├── components/               ← React components (admin UI, interview UI)
│   │   ├── lib/                      ← GraphQL client, auth helpers, audio upload queue
│   │   └── hooks/                    ← Custom hooks (useInterviewState, usePTT, useSSE)
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
└── .github/
    └── workflows/                    ← CI/CD pipeline (Task 14)
```

---

## Implementation Tasks (Sequential)

Give Claude Code these tasks one at a time. Complete and verify each before moving to the next. Each task builds on previous work.

---

### Task 0: Local Environment Setup

**Prompt for Claude Code:**
> Read the "Local Development Environment" section of interview-spec-v2.md.
> Set up the local development environment:
>
> 1. Create docker-compose.yml at the project root with Postgres 15 and Redis 7
>    per the spec
> 2. Initialize the project structure: CDK app in /infrastructure, a Fastify API
>    project in /api with Prisma and Vitest, and a Next.js project in /frontend.
>    Set up tsconfig, package.json for all three.
> 3. Create .env.local with the mock defaults from the spec (Cognito bypass,
>    ElevenLabs mock, etc.). Add .env.local to .gitignore.
> 4. Set up Vitest configuration in /api (vitest.config.ts) with three test
>    scripts: test (unit), test:int (integration), test:e2e (end-to-end)
> 5. Create minimal stub Dockerfiles for both API and frontend — just enough to
>    build an image that returns HTTP 200 on a health check endpoint. These are
>    placeholders that will be replaced in Task 13.
> 6. Set up CDK boilerplate for three stacks: FoundationStack, DataStack,
>    ComputeStack. Don't implement them yet — just scaffolding and imports.
> 7. Create CLAUDE.md at project root with: "Product: Arena (internal platform
>    codename). Company: Elastic Horizon. Backend: Fastify (not Express).
>    Testing: Vitest. Specs: interview-spec-v2.md and
>    conversation-protocol-spec-v3.md. Brand: brandStandards.md."
> 8. Create stub Lambda handlers that Task 4's CDK deploy will reference:
>    - api/src/lambda/cleaning-handler.ts — exports a handler that returns
>      `{ statusCode: 200, body: 'not implemented' }`
>    - api/src/lambda/reconciliation-handler.ts — same stub pattern
>    - api/src/lambda/user-sync-handler.ts — same stub pattern
>
>    These are placeholders. The real implementations come in later tasks
>    (user-sync in Task 1, cleaning in Task 10b, reconciliation in Task 10b).

**Verify:**
- `docker-compose up -d` starts Postgres and Redis without errors
- `cd api && npm run test` runs Vitest (no tests yet, but the runner works)
- `cd infrastructure && cdk synth` runs without errors (empty stacks)
- Both stub Dockerfiles build successfully: `docker build -t arena-api-stub ./api` and `docker build -t arena-frontend-stub ./frontend`
- All three stub Lambda handler files exist and export a valid handler function

---

### Task 1: Foundation Stack (CDK)

**Prompt for Claude Code:**
> Read the "AWS Service Mapping" and "Authentication and Authorization" sections
> of interview-spec-v2.md. Implement FoundationStack in
> infrastructure/lib/foundation-stack.ts. This stack creates:
>
> - VPC with public and private subnets across 2 AZs
> - Security groups for ALB, Fargate services, RDS, Redis, and Lambda
> - Application Load Balancer in public subnets with HTTPS listener (use a
>   placeholder certificate ARN for now)
> - Cognito User Pool configured as:
>   - Admin-invite-only (self-signup disabled)
>   - Email/password authentication with email verification
>   - Password policy: min 12 chars, require uppercase, lowercase, number, symbol
>   - Two groups: 'admin' and 'user'
> - Post-confirmation Lambda trigger on the Cognito user pool that will create
>   a row in the users table when a new account is confirmed (implement the
>   Lambda handler in api/src/lambda/user-sync-handler.ts — replacing the stub
>   from Task 0. It receives the Cognito post-confirmation event, extracts sub,
>   email, and name, and inserts into the users table. Use Prisma Client.
>   Handle idempotency: if the row already exists, skip silently.)
> - ECR repositories for api and frontend container images
>
> Export all resource references needed by downstream stacks (VPC, security
> groups, ALB, Cognito user pool ID, client ID, ECR repo URIs).
>
> **Important:** The user-sync Lambda writes to the users table, but the
> database and schema don't exist until Tasks 2–3. The Lambda will deploy
> successfully (CDK creates the function), but it will fail at runtime if
> invoked before the database is ready. This is expected. Do NOT test the
> Lambda end-to-end in this task — only verify it deploys. End-to-end testing
> of the post-confirmation trigger should be done after Task 3 is complete.

**Verify:** `cdk deploy FoundationStack` succeeds. Check the AWS console to
confirm VPC, ALB, Cognito pool with both groups, ECR repos, and the
post-confirmation Lambda all exist. (Do NOT create a Cognito user yet — the
Lambda can't write to the DB until Task 3.)

---

### Task 2: Data Stack (CDK)

**Prompt for Claude Code:**
> Read the "AWS Service Mapping" and "ElevenLabs API Contract" sections of
> interview-spec-v2.md. Implement DataStack in infrastructure/lib/data-stack.ts.
> This stack imports resources from FoundationStack and creates:
>
> - RDS PostgreSQL instance (db.t3.micro for dev) in private subnets, using
>   the RDS security group from FoundationStack
> - ElastiCache Redis cluster (single node, cache.t3.micro for dev) in private
>   subnets
> - S3 bucket for audio storage with TWO lifecycle policy rules:
>   - Prefix `interviews/*/responses/`: Glacier after 90 days, delete after 365
>   - Prefix `interviews/*/drafts/`: Glacier after 30 days, delete after 90
> - Secrets Manager secrets (all with placeholder values — I'll update manually):
>   - `arena/claude-api-key`
>   - `arena/elevenlabs-api-key`
>   - RDS connection string (auto-generated from RDS construct)
>
> Security group rules: RDS accepts inbound from Fargate and Lambda security
> groups only. Redis accepts inbound from Fargate security group only.
>
> Export all resource references needed by ComputeStack.

**Verify:** `cdk deploy DataStack` succeeds. Confirm RDS, Redis, S3 (with
correct lifecycle rules), and all three secrets exist in the console.

---

### Task 3: Prisma Schema and Migrations

**Prompt for Claude Code:**
> Read the "Data Model" section of interview-spec-v2.md in its entirety,
> including the index strategy table. Implement the full Prisma schema in
> api/prisma/schema.prisma matching every table, column, type, constraint,
> and relationship defined in the spec. Key things to get right:
>
> - Use VARCHAR with CHECK constraints (not Postgres ENUMs) for all status and
>   type fields — the spec is explicit about this
> - Include is_active on tags and questions
> - Include all new columns on interview_responses: input_mode,
>   audio_upload_status, is_skipped, error_message
> - Include the response_drafts table with all audio fields
> - Include template_assignment_history table
> - Include session_snapshot and paused_at on interviews
> - Include current_template_id, template_assigned_at, template_assigned_by
>   on users (NOT a user_templates junction table — the spec removed it)
> - Add the 'paused' status to the interviews status CHECK constraint
> - Define ALL composite indexes from the index strategy table using @@index
> - JSONB fields for: tags_at_time, followup_triggers, session_snapshot
>
> Configure the Prisma datasource to use the DATABASE_URL environment variable.
> Generate the migration files.
>
> Write a seed script in api/prisma/seed.ts that creates:
> - 5 tags (mixed types, including 1 inactive tag)
> - 10 questions with tag associations (including 1 inactive question)
> - 1 template with 6 ordered questions including follow-up triggers
> - 1 admin user and 1 standard user, both with tags
> - Template assigned to the standard user (via current_template_id FK)
> - 1 template_assignment_history record for the assignment
>
> Write unit tests in api/src/__tests__/seed.test.ts that verify the seed
> data integrity: correct counts, relationships, and constraints.
>
> After verifying the seed works, also test the user-sync Lambda from Task 1
> end-to-end: create a user in Cognito and confirm the post-confirmation
> trigger writes a row to the users table. (The Lambda was deployed in Task 1
> but couldn't be tested until the database and schema existed.)

**Verify:**
- `docker-compose up -d` (Postgres running)
- `cd api && npx prisma migrate dev` succeeds
- `cd api && npx prisma db seed` succeeds
- `cd api && npm run test` — seed tests pass
- `npx prisma studio` shows correct data and relationships
- Create a Cognito user (via AWS console or CLI) and verify a row appears in the
  users table via Prisma Studio

---

### Task 4: Compute Stack (CDK)

**Prompt for Claude Code:**
> Read the "AWS Service Mapping" and "Reconciliation and Background Jobs"
> sections of interview-spec-v2.md. Implement ComputeStack in
> infrastructure/lib/compute-stack.ts. This stack imports resources from
> FoundationStack and DataStack and creates:
>
> **ECS Cluster and Fargate Services:**
> - ECS cluster in the VPC
> - API Fargate service: use a **placeholder public nginx image** (NOT the
>   /api Dockerfile — it doesn't have production code yet). Runs in private
>   subnets, 2 tasks (min 1, max 4 with auto-scaling), 512 CPU / 1024 MB.
>   Environment variables: DATABASE_URL (from Secrets Manager), REDIS_URL
>   (from Redis endpoint), COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID,
>   S3_AUDIO_BUCKET, CLAUDE_API_KEY (from Secrets Manager),
>   ELEVENLABS_API_KEY (from Secrets Manager), OTEL_EXPORTER_OTLP_ENDPOINT,
>   OTEL_SERVICE_NAME=arena-api.
>   IAM task role: read Secrets Manager, read/write S3, publish to EventBridge,
>   full access to SQS.
> - Frontend Fargate service: use a **placeholder public nginx image**.
>   Runs in private subnets, 2 tasks (min 1, max 2), 256 CPU / 512 MB.
>   Environment variable: NEXT_PUBLIC_API_URL pointing to the ALB.
>
> **ALB Routing:**
> - Path-based routing: /api/* and /graphql → API service,
>   everything else → frontend service
>
> **Post-Interview Pipeline:**
> - EventBridge rule matching `interview.completed` events
> - SQS queue (InterviewCleaningQueue) as EventBridge target
> - SQS dead letter queue for failed cleaning attempts (max 3 retries)
> - Lambda function (CleaningLambda) triggered by SQS, built from the stub
>   handler in /api/src/lambda/cleaning-handler.ts (created in Task 0).
>   Runtime Node.js 20. Environment variables: DATABASE_URL and
>   CLAUDE_API_KEY from Secrets Manager, OTEL_EXPORTER_OTLP_ENDPOINT,
>   OTEL_SERVICE_NAME=arena-cleaning.
>   IAM role: read Secrets Manager, consume SQS, connect to RDS.
>
> **Reconciliation:**
> - Lambda function (ReconciliationLambda) built from the stub handler in
>   /api/src/lambda/reconciliation-handler.ts (created in Task 0).
>   Runtime Node.js 20. Timeout 5 minutes. Environment variables:
>   DATABASE_URL from Secrets Manager, S3_AUDIO_BUCKET,
>   OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME=arena-reconciliation.
>   IAM role: read/write RDS, list S3 objects in the interview audio prefix.
> - EventBridge scheduled rule: rate(15 minutes) → ReconciliationLambda
>
> **Important:** Use placeholder nginx images for Fargate services. The real
> Docker images will be built and deployed in Task 13. The placeholder services
> should pass ALB health checks (nginx returns 200 on /). The Lambda functions
> use the stub handlers from Task 0 — they deploy and invoke successfully but
> return 'not implemented'. The real implementations come in Task 10b.

**Verify:** `cdk deploy ComputeStack` succeeds. Confirm ECS cluster, both
Fargate services (passing health checks with nginx), both Lambdas, SQS queues,
and both EventBridge rules exist in the console.

---

### Task 5: GraphQL API — Core CRUD

**Prompt for Claude Code:**
> Read the "GraphQL Schema Design", "Observability and Error Handling", and
> "Constraints and Guardrails" sections of interview-spec-v2.md.
> Implement the Apollo Server GraphQL API in /api/src:
>
> 1. Fastify server with Apollo Server plugin (@as-integrations/fastify)
> 2. Cognito JWT validation middleware with local dev bypass (when
>    COGNITO_BYPASS=true, use mock user from env vars)
> 3. OpenTelemetry auto-instrumentation setup: install @opentelemetry/sdk-node
>    and auto-instrumentation packages. Configure OTel Collector export to
>    ClickHouse Cloud endpoint. Ensure NO PII (names, emails, transcription
>    content) appears in any span or log — only UUIDs, error codes, stack
>    traces, metrics, and timestamps.
> 4. Standard error handling: implement the typed error code pattern from the
>    spec. Every resolver wraps errors with the correct code from the standard
>    vocabulary (NOT_FOUND, DUPLICATE_ENTRY, INVALID_STATE, UNAUTHORIZED,
>    FORBIDDEN, VALIDATION_ERROR, INTERNAL_ERROR, EXTERNAL_SERVICE_ERROR).
>    All errors are logged as structured OTel events.
> 5. GraphQL schema with all types from the "GraphQL Schema Design" section,
>    including the cursor-based pagination connection types (QuestionConnection,
>    QuestionEdge, PageInfo, etc.)
> 6. Resolvers for all queries and mutations EXCEPT:
>    - Interview engine mutations (startInterview, submitResponse,
>      completeInterview, skipQuestion, pauseInterview, resumeInterview)
>    - Audio mutations (requestResponseAudioUploadUrl, requestDraftAudioUploadUrl,
>      confirmAudioUpload, confirmDraftAudioUpload)
>    - Draft mutations (saveDraft)
>    - Pipeline mutations (updateCleanedContent)
>    - REST endpoints (/api/tts-token, /api/interview/:id/stream, /api/heartbeat)
> 7. Implement these business rule validations with correct error codes:
>    - createTag: DUPLICATE_ENTRY on existing label
>    - assignTemplateToUser: INVALID_STATE if template not published, NOT_FOUND
>      if template doesn't exist. Writes to template_assignment_history.
>    - updateTemplate(status: published): INVALID_STATE if zero questions
>    - removeQuestionFromTemplate: INVALID_STATE if referenced in follow-up
>      triggers
>    - updateTag/updateQuestion with isActive: return warning in response if
>      used in published templates (but don't block)
> 8. Cursor-based pagination on: getQuestions, getInterviewsByUser,
>    getDraftsForResponse, getTemplateAssignmentHistory. Default page size 25,
>    max 100.
> 9. DataLoader setup for batched resolution of tags, questions, and responses
> 10. Prisma Client integration for all database operations
> 11. Admin-only enforcement: tag, question, template, and user mutations check
>     for 'admin' in the cognito:groups claim. Return FORBIDDEN if not admin.
>
> Do NOT create deleteTag, deleteQuestion, or deleteTemplate mutations.
> These are explicitly prohibited by the spec.
>
> Write unit tests for every resolver: test the happy path, test each error
> code, test pagination cursors, test admin-only enforcement.

**Verify:**
- `cd api && npm run dev` starts the server
- Test all CRUD operations via Apollo Sandbox with the Cognito bypass
- Toggle COGNITO_MOCK_GROUPS to 'user' and verify admin mutations return FORBIDDEN
- Verify error codes: try creating a duplicate tag, publishing an empty template,
  assigning an archived template
- `cd api && npm run test` — all resolver tests pass
- Verify OTel traces appear in ClickHouse for the requests made during testing
  (this confirms the instrumentation from step 3 is working end-to-end)

---

### Task 6: Interview Engine — Redis Session Management

**Prompt for Claude Code:**
> Read the "LLM Interview Orchestration" section of interview-spec-v2.md and
> the "Data Flow Per Turn" and "Pause and Resume Protocol" sections of
> conversation-protocol-spec-v3.md.
>
> Implement Redis session management and the startInterview mutation:
>
> 1. Redis client setup (connect to ElastiCache in production, localhost in dev)
> 2. Interview session state structure matching the Redis Session Structure
>    in conversation-protocol-spec-v3.md Section 5
> 3. startInterview mutation:
>    - Validate: user has a current_template_id (INVALID_STATE if not)
>    - Validate: user does not have an existing in_progress or paused interview
>      (INVALID_STATE if so)
>    - Create interview record in DB with status 'in_progress'
>    - Fetch template with all template_questions, ordered by sequence_order
>    - Separate required vs optional questions, group by category_bucket
>    - Load follow-up trigger definitions for each question
>    - Initialize Redis session with full state
>    - Return interview ID and template metadata
>    - **Note:** This is intentionally partial. The SSE stream for the first
>      LLM question will be added in Task 8b. Task 8b will update this mutation
>      AND update the tests written here to account for the changed behavior.
> 4. pauseInterview mutation:
>    - Snapshot Redis session state to interviews.session_snapshot JSONB
>    - Set interview status to 'paused', set paused_at timestamp
>    - Keep Redis session alive for 15 minutes (TTL) for quick resume
> 5. resumeInterview mutation:
>    - Check Redis for existing session (warm resume)
>    - If not in Redis: reconstruct from session_snapshot + interview_responses
>    - Set interview status back to 'in_progress', clear paused_at
>    - Return session state for the frontend to restore UI
> 6. Write integration tests: start → verify Redis state → pause → verify
>    snapshot in DB → resume → verify Redis state restored. Test validation
>    errors (no template, already in progress).

**Verify:**
- Start an interview locally, inspect Redis state via redis-cli
- Pause the interview, verify session_snapshot in Postgres
- Resume, verify Redis state matches
- Tests pass

---

### Task 7: Interview Engine — WebSocket STT Proxy

**Prompt for Claude Code:**
> Read the "ElevenLabs API Contract" section of interview-spec-v2.md and the
> "Architecture Overview" and "Security Considerations" (WebSocket
> Authentication) sections of conversation-protocol-spec-v3.md.
>
> Implement the WebSocket STT proxy on Fastify:
>
> 1. WebSocket endpoint at /stt that accepts connections with query parameters:
>    ?token=<JWT>&interviewId=<UUID>
> 2. On connection upgrade:
>    - Validate JWT against Cognito (or bypass in local dev)
>    - Extract user ID from JWT sub claim
>    - Verify interview exists, belongs to this user, and is in_progress
>    - Reject with 401/403 if validation fails
> 3. WebSocket message types from client:
>    - audio_start: opens a new STT session with ElevenLabs
>    - audio_chunk: binary audio data, proxied to ElevenLabs
>    - audio_end: closes the STT session
> 4. WebSocket message types to client:
>    - partial_transcript: streaming text from ElevenLabs
>    - final_transcript: complete transcription after audio_end
> 5. Progressive transcript assembly in Redis: append partial transcripts
>    to the session's currentTranscriptBuffer
> 6. ElevenLabs STT proxy:
>    - Connect to wss://api.elevenlabs.io/v1/speech-to-text/ws (verify
>      endpoint against current ElevenLabs docs)
>    - Use arena/elevenlabs-api-key from Secrets Manager (or env var locally)
>    - Audio format: WebM/Opus, 16kHz minimum, mono
> 7. Mock STT mode: when ELEVENLABS_MOCK=true, return canned transcriptions
>    with ~300ms delay per partial, simulating realistic timing
> 8. Write integration tests: connect WebSocket with mock JWT, send
>    audio_start, send test audio chunks, verify partial and final transcripts
>    arrive, verify Redis transcript buffer updates. Test auth rejection.

**Verify:**
- Use a WebSocket test client (wscat or a test script) to connect with
  a valid mock JWT and interview ID
- Send audio_start, audio_chunk (test data), audio_end
- Verify transcription messages arrive
- Verify Redis session's currentTranscriptBuffer is updated
- Tests pass

---

### Task 8a: Interview Engine — LLM Prompt Constructor and Per-Turn State Manager

**Prompt for Claude Code:**
> Read the "LLM Interview Orchestration" section of interview-spec-v2.md,
> specifically the "System Prompt Structure" and "Per-Turn State Update"
> sub-sections. Also read the "Follow-Up Trigger Evaluation" section of
> conversation-protocol-spec-v3.md.
>
> Implement the internal interview logic — the pieces that have no
> infrastructure dependencies (no SSE, no timers):
>
> 1. LLM system prompt constructor (a pure function / service):
>    - Takes template data (questions, ordering, categories) and builds the
>      system prompt per the "System Prompt Structure" section of
>      interview-spec-v2.md
>    - Include follow-up trigger definitions directly in the prompt (the LLM
>      evaluates them — no application-side keyword/sentiment/length services)
>    - Include instruction to skip triggers referencing missing questions
> 2. Per-turn state manager (a pure function / service):
>    - After each response: compute updated session state — questions asked,
>      buckets covered, remaining required/optional questions
>    - Build the state update payload for the LLM (per interview-spec-v2.md
>      "Per-Turn State Update")
>    - Do NOT pre-evaluate triggers — pass raw trigger definitions to the LLM
> 3. submitResponse mutation (database and Redis logic only — no streaming):
>    - Write interview_responses record in a single Postgres transaction
>    - Include input_mode and audio_upload_status fields
>    - Update Redis session state via the per-turn state manager
>    - Call Claude API with streaming enabled: system prompt + conversation
>      history + per-turn state + user response
>    - **Collect the full LLM response in memory** (do not stream to client
>      yet — SSE delivery is Task 8b). Store the response text in Redis
>      session state for the SSE layer to pick up.
>    - Return responseId to the caller
> 4. skipQuestion mutation (database and Redis logic only — no streaming):
>    - Write interview_responses record with is_skipped=true
>    - Update Redis session (mark question as skipped)
>    - Call Claude API for next question, collect full response in memory
> 5. completeInterview mutation:
>    - Persist final interview state to DB (status='completed', completed_at)
>    - Flush Redis session
>    - Publish interview.completed event to EventBridge
> 6. Update startInterview mutation (from Task 6) to call the LLM for the
>    first question using the prompt constructor, collecting the response in
>    memory. Update Task 6's startInterview tests to account for this.
> 7. Write unit tests:
>    - Prompt constructor: verify output structure, trigger inclusion, missing
>      question handling
>    - State manager: verify state transitions, bucket coverage tracking,
>      required/optional question tracking
>    - submitResponse: mock Claude API, verify DB writes, verify Redis state
>      updates, verify response collection
>    - skipQuestion: verify is_skipped record, verify state update
>    - completeInterview: verify DB status, Redis flush, EventBridge event
>    - Full flow: start → submit → submit → skip → complete (all via
>      mutations, no SSE)

**Verify:**
- Start an interview, submit responses via GraphQL mutations, verify DB and
  Redis state updates are correct
- LLM responses are collected and available in Redis session state
- Skip a question, verify state updates
- Complete the interview, verify EventBridge event fires
- Tests pass

---

### Task 8b: Interview Engine — SSE Streaming Infrastructure

**Prompt for Claude Code:**
> Read the "SSE Stream Message Types" section (Section 14) and the "Message
> Sequence — Complete Turn Cycle" section of conversation-protocol-spec-v3.md.
>
> Implement the SSE streaming layer that delivers LLM responses to the
> frontend. This task wires up the streaming infrastructure on top of the
> interview logic built in Task 8a:
>
> 1. SSE endpoint: GET /api/interview/:id/stream
>    - Requires Cognito JWT in Authorization header (or bypass in local dev)
>    - Verify interview belongs to authenticated user
>    - Long-lived connection for pushing LLM responses, idle prompts, and
>      auto-pause notifications
>    - Message types: token, sentence_complete, stream_complete, error
>      (per conversation-protocol-spec-v3.md Section 14)
> 2. Refactor submitResponse and skipQuestion (from Task 8a) to stream LLM
>    tokens through the SSE connection instead of collecting in memory:
>    - Stream LLM response tokens back via SSE as they arrive
>    - Detect sentence boundaries and emit sentence_complete events
>    - When stream completes: emit stream_complete with next question metadata,
>      interviewComplete flag, and progressPercent
> 3. Refactor startInterview to stream the first LLM question via SSE after
>    session initialization (instead of collecting in memory).
> 4. TTS token endpoint: GET /api/tts-token
>    - Requires Cognito JWT
>    - Returns the ElevenLabs API key (or a scoped token if ElevenLabs supports
>      it) for frontend TTS calls
>    - Key sourced from arena/elevenlabs-api-key Secrets Manager secret
> 5. Update Task 8a's tests to account for the streaming behavior — tests
>    should now verify that the SSE stream is initiated and tokens are
>    delivered correctly.
> 6. Write integration tests:
>    - Connect to SSE endpoint, start interview, verify first question streams
>    - Submit response, verify token → sentence_complete → stream_complete
>      sequence
>    - Verify stream_complete includes correct metadata (next question,
>      progress, interviewComplete flag)
>    - Test error message delivery via SSE

**Verify:**
- Start an interview locally, connect to SSE endpoint
- Submit a response, see LLM tokens stream via SSE
- Verify sentence_complete and stream_complete messages arrive with correct
  metadata
- Skip a question, verify next question streams
- Tests pass

---

### Task 8c: Interview Engine — Inactivity Handling and Heartbeats

**Prompt for Claude Code:**
> Read the "Inactivity Handling" section of conversation-protocol-spec-v3.md.
>
> Implement the temporal logic for idle detection, heartbeats, and auto-pause.
> This builds on the SSE infrastructure from Task 8b:
>
> 1. Inactivity timer:
>    - After each LLM response, set lastActivityAt in Redis
>    - Background check (per-connection interval): if 60 seconds idle, trigger
>      LLM idle prompt via SSE (idle_prompt message type)
>    - If 3 minutes idle after warning: auto-pause via pauseInterview mutation,
>      send auto_paused message via SSE
> 2. Heartbeat endpoint: POST /api/heartbeat
>    - Requires Cognito JWT
>    - Updates lastActivityAt in Redis for the user's active interview
>    - Returns 200 OK
> 3. Heartbeat timeout: if heartbeats stop for 5 minutes, auto-pause the
>    interview
> 4. Write integration tests:
>    - Test idle prompt fires after 60 seconds of inactivity
>    - Test auto-pause fires after 3 minutes of inactivity
>    - Test heartbeat resets the inactivity timer
>    - Test heartbeat timeout triggers auto-pause
>    - Test that activity (submitResponse) also resets the timer

**Verify:**
- Start an interview, connect to SSE
- Wait 60 seconds, verify idle_prompt arrives via SSE
- Wait 3 minutes total, verify auto_paused arrives via SSE and interview
  status is 'paused' in DB
- Test heartbeat keeps the session alive
- Tests pass

---

### Task 9: Frontend — Minimum Viable Interview (Text-Only)

**Prompt for Claude Code:**
> Read Sections 3 (Frontend State Machine), 13 (UI Layout), and 14 (SSE
> Stream Message Types) of conversation-protocol-spec-v3.md. Also read
> brandStandards.md for styling.
>
> Build the minimum viable interview experience with text input only. The
> purpose of this task is to validate the end-to-end interview flow —
> including the data shape of follow-up triggers — before building the full
> admin template builder UI. This ensures the trigger configuration format
> actually works at runtime in the LLM's prompt.
>
> **Step 1 — Shared frontend infrastructure (used by both admin and interview
> UIs):**
> Set up the following foundational pieces before building pages:
> - Apollo Client configured to point at the API (with auth headers)
> - Cognito authentication flow using aws-amplify: login page with
>   email/password, session management, JWT token handling
> - Brand theme from brandStandards.md applied globally: CSS variables for
>   colors, IBM Plex Sans typography, --horizon-red for primary CTAs,
>   --ivory for page backgrounds
> - App-level routing layout: /admin/* for admin pages, / for interview
>   pages. Cognito group check on /admin/* routes (redirect non-admin users).
>
> **Step 2 — Core interview UI:**
> 1. Interview landing page: user sees their assigned template name and
>    description. "Start Interview" button. If no template assigned, show
>    a message.
> 2. Implement the frontend state machine from Section 3:
>    READY → STARTING → AWAITING_INPUT → PROCESSING → LLM_STREAMING →
>    COMPLETING → COMPLETED. Plus: PAUSED, RESUMING, ERROR.
>    (Audio-related states — RECORDING, REVIEW, REDO, UPLOADING — will be
>    added in Task 12b. IDLE_WARNING and AUTO_PAUSED in Task 12d.)
> 3. Hybrid UI layout per Section 13: current question focused at top
>    (--dark-maroon background, --ivory text), scrollable transcript below,
>    input area at bottom with text field. Progress bar (--horizon-red,
>    no numbers). Pause and End Interview buttons in header.
> 4. Text input: typing in the text field and pressing Enter submits with
>    inputMode='text', transitions to PROCESSING → LLM_STREAMING.
> 5. SSE connection to /api/interview/:id/stream:
>    - Display LLM response tokens in the current question panel
>    - Handle token, sentence_complete, stream_complete, error message types
>    - On stream_complete: transition to AWAITING_INPUT with next question,
>      update progress bar
> 6. Skip button (visible for non-required questions only)
> 7. Pause and resume — transitions to PAUSED, calls pauseInterview mutation,
>    resume button calls resumeInterview and restores UI state
> 8. End Interview button — calls completeInterview, transitions to COMPLETED
>    with summary
> 9. Apply brand standards throughout. No Space Grotesk in the interview UI.
>
> **Step 3 — Validate follow-up triggers end-to-end:**
> Using the seed data from Task 3 (which includes a template with follow-up
> triggers), run a complete text-only interview and verify:
> - Follow-up triggers fire correctly based on user responses
> - The LLM receives and acts on trigger definitions in its prompt
> - The data shape of followup_triggers in the template_questions table is
>   sufficient for the runtime to work
> - Document any data shape issues discovered — these must be addressed
>   before building the admin template builder in Task 10.

**Verify:** Log in as a standard user → start interview → respond via text →
see LLM response stream → verify follow-up triggers fire when expected →
skip a question → pause → resume → complete. Full text-only flow works
end-to-end. Follow-up trigger data shape is validated.

---

### Task 10: Admin Interface

**Prompt for Claude Code:**
> Read the "Admin Interface Specifications" section of interview-spec-v2.md
> and brandStandards.md for styling. Build the admin interface in /frontend
> using Next.js, React, and shadcn/ui.
>
> **Important:** Task 9 validated that the follow-up trigger data shape works
> at runtime. If any data shape issues were documented in Task 9, address
> them in the Prisma schema and GraphQL API BEFORE building the admin UI.
> The template builder must produce trigger configurations that the runtime
> actually consumes correctly.
>
> **Admin pages:**
> 1. Tag management page: CRUD with type selection dropdown, is_active toggle
>    with warning when deactivating tags used in published templates,
>    duplicate detection, usage counts (question count, user count per tag).
>    Hide inactive tags by default with a "Show inactive" toggle.
> 2. Question bank page: paginated list (cursor-based, 25 per page) with tag
>    filtering and search, is_active toggle with warning, create/edit modals
>    with tag association via multi-select. Hide inactive by default.
> 3. Template builder: multi-step workflow per the spec:
>    - Question selection (only active questions shown)
>    - Drag-and-drop ordering
>    - Category bucketing
>    - Follow-up trigger configuration (keyword, sentiment, length, always)
>      with multi-select of other template questions as follow-up targets
>    - Required/optional toggle per question
>    - Preview (collapsible outline showing full interview flow)
>    - Publish (fails with clear error if zero questions)
> 4. User management: list users, assign/reassign templates (dropdown of
>    published templates only), bulk assignment, view assignment history
>
> Use path-based routing: /admin/* for all admin pages.

**Verify:** Run the frontend locally, log in via Cognito (or bypass), and test
the full admin workflow: create tags → create questions → build template →
configure follow-up triggers → publish → assign to user. Verify soft-delete
toggles work with warnings. Verify pagination on question bank. Then log in
as a standard user and run a text-only interview using the newly created
template to confirm triggers work end-to-end.

---

### Task 10a: Audio Upload and Draft Mutations

**Prompt for Claude Code:**
> Read the "Audio Architecture" section of conversation-protocol-spec-v3.md
> Section 2 and the relevant parts of interview-spec-v2.md.
>
> Implement audio upload and draft mutations:
>
> 1. Audio upload mutations:
>    - requestResponseAudioUploadUrl(interviewId, responseId): generate
>      presigned S3 PUT URL scoped to
>      interviews/{interviewId}/responses/{responseId}/audio.webm.
>      URL expires in 15 minutes. Verify interview belongs to user.
>    - requestDraftAudioUploadUrl(interviewId, draftId): same pattern,
>      scoped to interviews/{interviewId}/drafts/{draftId}/audio.webm
>    - confirmAudioUpload(responseId, s3Key, mimeType, durationSeconds):
>      update interview_responses audio fields and set
>      audio_upload_status='uploaded'
>    - confirmDraftAudioUpload(draftId, s3Key, mimeType, durationSeconds):
>      update response_drafts audio fields and set
>      audio_upload_status='uploaded'
> 2. saveDraft mutation:
>    - Create response_drafts record with content, input_mode,
>      stt_confidence_score, incrementing draft_number
>    - Return draftId
> 3. Write tests:
>    - Audio mutations: verify presigned URL generation, confirm upload updates
>    - Draft mutations: verify draft creation, incrementing draft numbers

**Verify:**
- Test presigned URL generation via Apollo Sandbox
- Use the presigned URL to upload a test file to S3
- Confirm audio upload updates the response record
- Tests pass

---

### Task 10b: Cleaning and Reconciliation Lambdas

**Prompt for Claude Code:**
> Read the "Post-Interview Cleaning Pipeline" and "Reconciliation and
> Background Jobs" sections of interview-spec-v2.md.
>
> Implement the post-interview pipeline Lambdas, replacing the stubs from
> Task 0:
>
> 1. Cleaning Lambda (api/src/lambda/cleaning-handler.ts):
>    - Consume messages from InterviewCleaningQueue (each contains interview ID)
>    - Fetch all responses where processing_status='pending'
>    - For each: set to 'cleaning', call Claude API with cleaning prompt,
>      write cleaned_markdown + cleaning_model + cleaned_at, set to 'cleaned'
>    - On failure: set to 'error', write failure reason to error_message,
>      log to ClickHouse, continue with remaining responses
>    - Include OTel instrumentation on the Lambda
> 2. Reconciliation Lambda (api/src/lambda/reconciliation-handler.ts):
>    - Scan 1: stuck cleaning states (processing_status='cleaning' for >10 min)
>      → reset to 'pending'
>    - Scan 2: audio upload inconsistencies (pending >1 hour, failed uploads,
>      orphaned S3 objects) → flag for admin
>    - Scan 3: paused interview auto-abandonment (paused_at >72 hours)
>      → set status='abandoned', fire interview.abandoned EventBridge event
>    - Include OTel instrumentation
> 3. updateCleanedContent mutation (internal, called by cleaning Lambda):
>    - Update cleaned_markdown, cleaning_model, cleaned_at, processing_status
> 4. Write tests:
>    - Cleaning Lambda: mock SQS message, mock Claude API, verify DB updates
>    - Reconciliation Lambda: seed stuck records, run scan, verify resets

**Verify:**
- Manually publish test message to SQS with an interview ID that has uncleaned
  responses. Confirm the Lambda processes them and cleaned_markdown appears.
- Seed a response stuck in 'cleaning' for 15 minutes. Run reconciliation.
  Verify it resets to 'pending'.
- Tests pass.

---

### Task 12a: Frontend — Interview State Machine and Text-Only Flow (Full Polish)

**Prompt for Claude Code:**
> Task 9 built the minimum viable text-only interview flow. This task adds
> polish and any remaining text-only features that were deferred:
>
> 1. Review the state machine implementation from Task 9 and ensure all
>    transitions are fully robust (no edge-case gaps)
> 2. Ensure the scrollable transcript area handles long conversations well
>    (auto-scroll, scroll-to-bottom button)
> 3. Completion summary screen with interview statistics
> 4. Any text-only UI refinements identified during Task 9 or Task 10 testing

**Verify:** Full text-only interview flow is polished and production-ready.

---

### Task 12b: Frontend — Push-to-Talk, STT, and Audio Upload

**Prompt for Claude Code:**
> Read Sections 2 (Audio Architecture), 3 (state machine — RECORDING, REVIEW,
> REDO states), and 12 (WebSocket Authentication) of
> conversation-protocol-spec-v3.md.
>
> Add voice input to the interview experience built in Tasks 9 and 12a:
>
> 1. Add RECORDING, REVIEW, and REDO states to the state machine.
> 2. Push-to-talk button (pill shape, --horizon-red, --white icon):
>    - Press: start MediaRecorder + open authenticated STT WebSocket
>      (JWT + interviewId as query params per Section 12)
>    - During recording: stream audio chunks to STT WebSocket, display
>      live partial transcripts in the transcript area
>    - Release: stop MediaRecorder (capture audio Blob), close STT WebSocket,
>      show final transcript in REVIEW state
>    - Auto-send after ~2 seconds in REVIEW (unless user clicks Redo)
> 3. Redo flow: clicking Redo calls saveDraft mutation, queues draft audio
>    upload in background, returns to editable input state
> 4. Background audio upload queue:
>    - After auto-send: request presigned URL, upload audio Blob in background
>    - Retry up to 3 times with exponential backoff
>    - Call confirmAudioUpload on success
>    - Continue interview regardless of upload status
> 5. Add UPLOADING state: after completion, wait up to 60 seconds for pending
>    audio uploads, then transition to COMPLETED

**Verify:** Start interview → respond via push-to-talk → see live
transcription → see final transcript in REVIEW → auto-send fires → verify
audio appears in S3. Test redo flow. Test that interview continues even if
audio upload fails.

---

### Task 12c: Frontend — TTS Playback, SSE Sentence Buffering, and Draft Management

**Prompt for Claude Code:**
> Read the "ElevenLabs API Contract" section of interview-spec-v2.md and
> Sections 2 and 14 of conversation-protocol-spec-v3.md.
>
> Add TTS playback and polish the streaming experience:
>
> 1. TTS: fetch token from GET /api/tts-token, call ElevenLabs TTS API
>    directly from frontend with sentence-level chunks. Auto-play audio.
>    Degrade gracefully to text-only if TTS fails.
>    When ELEVENLABS_MOCK=true (detected via mock token), skip TTS calls.
> 2. SSE sentence buffering: buffer sentence_complete events and feed them
>    to TTS sequentially so audio plays in order without overlap.
> 3. Handle idle_prompt and auto_paused SSE message types:
>    - idle_prompt: display the LLM's nudge message, play via TTS
>    - auto_paused: transition to AUTO_PAUSED state with resume option
> 4. Add IDLE_WARNING and AUTO_PAUSED states to the state machine.
> 5. Draft management: ensure saveDraft integrates cleanly with redo flow,
>    draft audio uploads happen in background, draft history is accessible.

**Verify:** Start interview → submit response → hear LLM response via TTS
with sentences playing in order → wait 60 seconds, hear idle prompt → wait
3 minutes, see auto-pause. Test with ELEVENLABS_MOCK=true (text-only
fallback works).

---

### Task 12d: Frontend — Error Recovery, Edge Cases, and Interview History

**Prompt for Claude Code:**
> Read Section 15 (Error Recovery) of conversation-protocol-spec-v3.md in
> its entirety.
>
> Harden the interview experience and add the history page:
>
> 1. Error recovery per Section 15:
>    - STT WebSocket drops: reconnect automatically, resume recording
>    - LLM stream errors: show error message, allow retry
>    - TTS failures: degrade to text-only silently
>    - Audio upload failures: continue interview, flag for reconciliation
>    - Browser close: beforeunload handler warns user, auto-pauses interview
>    - Network disconnection: detect, show reconnecting UI, resume on
>      reconnect
> 2. Edge cases:
>    - Rapid state transitions (double-click submit, click skip during
>      streaming)
>    - Browser back/forward during interview
>    - Tab visibility change (pause heartbeat when hidden)
>    - Very long responses (scroll management)
> 3. Interview history page: paginated list of past interviews with
>    responses, processing status, cleaned markdown when available
> 4. Comprehensive error state UI: clear messages for each failure mode,
>    retry buttons where applicable

**Verify:** Test each error scenario: kill the WebSocket mid-recording (verify
reconnect), simulate LLM error (verify retry), disable network (verify
reconnecting UI), close browser tab during interview (verify pause on
return). Check interview history page shows past interviews with cleaned
content.

---

### Task 13: Dockerize and Deploy

**Prompt for Claude Code:**
> Create production Dockerfiles for both the API and frontend, replacing
> the stub Dockerfiles from Task 0:
>
> - API Dockerfile: multi-stage build, install dependencies, generate Prisma
>   client, build TypeScript, run migrations on startup (npx prisma migrate
>   deploy), expose the Fastify server port. Include OTel collector sidecar
>   configuration.
> - Frontend Dockerfile: multi-stage build with Next.js standalone output
>
> Build both images, push to the ECR repositories created in the Foundation
> Stack. Update the Fargate task definitions in the Compute Stack to reference
> the new images (replacing the nginx placeholders). Deploy via
> `cdk deploy ComputeStack`.
>
> Verify both services pass ALB health checks and are accessible via the
> ALB DNS name.

**Verify:** Hit the ALB URL in a browser. Confirm the frontend loads and can
communicate with the API. Test login, admin CRUD, and a full interview flow
in the deployed environment.

---

### Task 14: CI/CD Pipeline (Optional)

**Prompt for Claude Code:**
> Set up a CI/CD pipeline using GitHub Actions:
>
> - On push to main:
>   1. Run Vitest test suite (unit + integration)
>   2. Build Docker images for API and frontend
>   3. Push to ECR
>   4. Update Fargate services
>   5. Run Prisma migrations as part of API deployment
> - On push to infrastructure/*:
>   1. Run cdk diff
>   2. Optionally cdk deploy (manual approval gate)
> - Environment secrets (AWS credentials, ClickHouse endpoint, etc.) stored
>   as GitHub Actions secrets
> - Fail the pipeline if any test fails — don't deploy broken code

**Verify:** Push a small code change to main and confirm the pipeline runs
tests, builds, pushes, and deploys automatically.

---

## Operational Guidance

### CDK Deployment Failures

- If `cdk deploy` fails partway through, CloudFormation will attempt automatic rollback
- If rollback succeeds: fix the issue in code and re-deploy
- If rollback fails (ROLLBACK_FAILED state): use `cdk destroy <StackName>` to clean up, then re-deploy. **Caution:** `cdk destroy` on Data Stack deletes RDS and S3 data.
- Always deploy in dependency order: Foundation → Data → Compute
- For partial updates (e.g., just changing a Lambda): `cdk deploy ComputeStack` updates only changed resources

### Secrets Management

- Never hardcode API keys in code or .env files committed to git
- All production secrets live in AWS Secrets Manager: `arena/claude-api-key`, `arena/elevenlabs-api-key`, RDS connection string
- For local dev: use `.env.local` (in .gitignore)
- Rotate keys by updating the secret in Secrets Manager and restarting Fargate tasks

### Database Migrations

- Always run `npx prisma migrate dev` locally first
- For production: migrations run automatically on API container startup (`npx prisma migrate deploy`)
- Never modify an applied migration file — create a new migration

---

## Notes for Claude Code Usage

- **Run tasks sequentially.** Each task builds on the previous one. Don't skip ahead.
- **Verify after each task.** The verification steps catch issues early before they compound.
- **Use planning mode** for complex tasks (especially Tasks 8a–8c and 12a–12d). Tell Claude Code to read the relevant spec sections and plan before writing code.
- **Two specs, not one.** interview-spec-v2.md covers data/infra/API. conversation-protocol-spec-v3.md covers runtime conversation behavior. Both are authoritative.
- **The spec wins.** If Claude Code makes a decision that conflicts with either spec, the spec takes precedence.
- **Fastify, not Express.** This is decided. Do not use Express anywhere.
- **Vitest, not Jest.** This is decided. Do not use Jest anywhere.
- **No delete mutations.** deleteTag, deleteQuestion, and deleteTemplate are explicitly prohibited.
- **No PII in telemetry.** Never log names, emails, or transcription content to ClickHouse.
- **Typed error codes.** Every GraphQL error must include extensions.code from the standard vocabulary.

---

*Implementation plan version 2.2. References interview-spec-v2.md and conversation-protocol-spec-v3.md. All task prompts reference spec sections by title.*
