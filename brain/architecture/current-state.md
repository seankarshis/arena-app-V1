# Arena — Current Architecture State

_Last updated: 2026-04-05_

## What's Running (EC2 Dev Environments)

Both environments run on a single EC2 instance with host-level nginx terminating TLS and
proxying to PM2-managed Node processes.

| Environment | Domain | Frontend port | API port | Postgres | Redis |
|-------------|--------|--------------|----------|----------|-------|
| appv1 | appv1.elastichorizon.com | 3000 | 3001 | 5432 | 6379 |
| seandev | seandev.elastichorizon.com | 3010 | 3011 | 5433 | 6380 |

- nginx config files live at `/etc/nginx/sites-available/<envname>`
- TLS certs managed by certbot / Let's Encrypt (auto-renewal configured)
- PM2 process names: `arena-api`, `arena-frontend` (appv1), `seandev-api`, `seandev-frontend`
- Each environment has its own Postgres database (Docker) and Redis (Docker)
- App code lives at `/home/ubuntu/arena-app/<envname>`

See `docs/dev-environments.md` for the full port table and setup instructions.

---

## API Layer (`api/`)

**Framework:** Fastify + Apollo Server (`@as-integrations/fastify`)
**ORM:** Prisma (PostgreSQL)
**Test runner:** Vitest

### Status: Fully implemented

- `api/src/server.ts` — Fastify server with CORS, Helmet, rate limiting, Apollo, SSE plugin
- `api/src/schema/typedefs.ts` — Full GraphQL schema
- `api/src/schema/resolvers.ts` — All resolvers implemented
- `api/src/schema/context.ts` — ArenaContext builder
- `api/src/middleware/auth.ts` — Cognito JWT validation hook; `COGNITO_BYPASS=true` for local dev
- `api/src/middleware/errors.ts` — Typed Apollo error codes
- `api/src/services/` — All services implemented (interviewEngine, sttProxy, etc.)
- `api/src/sse/` — SSE streaming endpoint for LLM responses
- `api/src/websocket/` — WebSocket handler for STT
- `api/src/observability/` — OTel + ClickHouse telemetry; validates config at startup
- `api/src/lambda/cleaning-handler.ts` — Fully implemented
- `api/src/lambda/reconciliation-handler.ts` — Fully implemented
- `api/src/lambda/user-sync-handler.ts` — Fully implemented
- `api/prisma/schema.prisma` — Full schema with migrations
- `api/.env.example` — All environment variables documented

### Known gaps
- Audio upload via S3 presigned URLs is **not implemented**. The two mutations
  (`requestResponseAudioUploadUrl`, `requestDraftAudioUploadUrl`) were removed from the
  schema until S3 infrastructure exists. `confirmAudioUpload` remains and writes to the DB.

---

## Frontend (`frontend/`)

**Framework:** Next.js 15 (App Router, standalone output)
**UI:** shadcn/ui (Radix primitives)
**GraphQL client:** Apollo Client

### Status: Fully implemented

- `frontend/src/app/` — All pages: login, admin, interview
- `frontend/src/components/` — Admin UI, interview UI (PushToTalkButton, TranscriptArea, etc.)
- `frontend/src/hooks/` — `useInterviewState`, `usePTT`, `useSSE`
- `frontend/src/app/api/health/route.ts` — Health endpoint (returns `{ status: "ok" }`)
- `frontend/next.config.mjs` — Committed; standalone output mode
- `frontend/.env.example` — All NEXT_PUBLIC_* variables documented

### Known gaps
- Test coverage is minimal — smoke tests only (health endpoint, Apollo client instantiation)
- No comprehensive component tests

---

## Infrastructure (`infrastructure/`)

**Framework:** AWS CDK v2 (TypeScript)
**Region:** us-east-1

### Status: Fully coded, NOT yet deployed to production

All three stacks are fully implemented. CDK `cdk synth` passes.

#### FoundationStack
- VPC (2 AZs, 1 NAT gateway, public + private subnets)
- Security groups: Lambda (outbound only), RDS, Redis
- Cognito User Pool (admin-invite-only, email sign-in, `admin` + `user` groups)
- Cognito App Client (no secret, SRP auth)
- S3 audio bucket (private, 90-day lifecycle, CORS for PUT)
- Secrets Manager references (not values — operators set values manually):
  - `arena/claude-api-key`
  - `arena/elevenlabs-api-key`
  - `arena/database-url`
  - `arena/log-hash-salt`
  - `arena/clickhouse-credentials` (JSON with CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, OTEL_EXPORTER_OTLP_ENDPOINT)
- User-sync Lambda (in this stack to avoid cross-stack Cognito trigger cycle — see ADR 002)

#### DataStack
- RDS PostgreSQL 15 (db.t3.micro, private subnets, RETAIN on destroy)
- ElastiCache Redis 7 (cache.t3.micro, single node, private subnets)
- CfnOutputs: RDS endpoint, Redis endpoint (used to populate `arena/database-url` manually)

#### ComputeStack
- SQS cleaning queue + DLQ
- Cleaning Lambda (SQS trigger from EventBridge interview-completion events)
- Reconciliation Lambda (EventBridge schedule, every 15 min)

> App compute (API + Frontend) runs on EC2 via nginx + PM2, not in these stacks. See ADR 004.

### Deployment prerequisite
Before `cdk deploy` can work end-to-end, these Secrets Manager values must be set manually
after the stacks are deployed. See `brain/runbooks/cdk-deploy-checklist.md`.

---

## CI/CD (`.github/workflows/`)

| File | Trigger | What it does |
|------|---------|--------------|
| `ci.yml` | Every push / every PR | Unit tests, integration tests, frontend tests |
| `deploy-dev.yml` | Push to main | SSHes into EC2, git pull, npm install, build, migrate, PM2 restart (appv1) |
| `deploy-seandev.yml` | Push to main | Same as above for seandev environment |
| `_deploy-ec2-env.yml` | Reusable (called by above) | Parameterised EC2 deploy logic |

**GitHub secrets required:** `EC2_SSH_KEY`, `EC2_HOST`, `EC2_USERNAME`, `AWS_ROLE_ARN`

---

## What Doesn't Exist Yet

- **Audio upload feature** — S3 presigned URL flow. Schema stubs removed. Implement after CDK deploy + S3 bucket confirmed working.
- **CDK stacks deployed** — FoundationStack (Cognito, user-sync Lambda) and DataStack (RDS, ElastiCache) have never been deployed. ComputeStack (Lambdas + SQS) likewise. See `brain/runbooks/cdk-deploy-checklist.md`.
- **Comprehensive frontend tests** — Only smoke tests exist.
