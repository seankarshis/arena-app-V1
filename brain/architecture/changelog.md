# Arena — Architecture Changelog

Reverse-chronological log of significant changes to architecture, conventions, and module status.
Update this file alongside `current-state.md` whenever a feature ships, a decision is made, or infrastructure changes.

---

## 2026-04-18 — Interview Bot Transformation, Phase 2 design complete

**Design artifacts landed. No code changes yet — Phase 3 implementation follows.**

- `brain/tasks/interview-bot-transformation/INTERVIEW_BOT_ANALYSIS.md` — Phase 1 discovery + ClickHouse event schema (approved-as-revised after observability-enforcer review).
- Ten ADRs under `brain/decisions/`:
  - ADR 005 — Tag model flat; admin + enrichment-service creation permitted.
  - ADR 006 — `Question.intent` (prose briefing) + `Question.sensitivityLevel` enum.
  - ADR 007 — Migrate `followupTriggers` to `TemplateQuestion.adminNotes` prose (one-release dual read).
  - ADR 008 — LLM-driven orchestration loop replaces deterministic `getNextQuestion` queue.
  - ADR 009 — Structured output via `---STATE_UPDATE---` text delimiters (not tool-use API).
  - ADR 010 — Context tiering + Anthropic prompt caching layout.
  - ADR 011 — Live vs async split: what blocks the turn vs what runs after.
  - ADR 012 — Async enrichment sidecar (`arena-enrichment` Lambda + SQS).
  - ADR 013 — Versioned prompt artifact pattern (`brain/specs/{name}-prompt-v{N}.md`).
  - ADR 014 — Five new ClickHouse event types: `orchestration_decisions`, `coverage_transitions`, `enrichment_jobs`, `flagged_items`, `state_parse_failures`.
- New versioned prompt spec: `brain/specs/interviewer-prompt-v1.md`.
- Diff-style spec bumps: `brain/specs/interview-spec-v3.md` supersedes v2 on tag/question/template changes; `brain/specs/conversation-protocol-spec-v4.md` supersedes v3 on runtime orchestration.
- CLAUDE.md updated: spec filenames pointed at v3/v4, versioned-prompt-artifact pattern noted, tag creation rule refined to admit admin inline creation and enrichment-service system creation.

**Phase 3 entry points** (for the implementation work that follows): `api/src/services/interviewEngine.ts`, `api/src/services/promptConstructor.ts` (replaced by `buildPrompt`), new `api/src/services/stateUpdateParser.ts`, coverage-map operations replacing pool mutations in `stateManager.ts`, Prisma migration adding `intent`, `sensitivityLevel`, `adminNotes`, `flagged_items`, `tag_merge_proposals`, `enrichment_outbox`, and five new emitters wired through `arena_telemetry`.

---

## 2026-04-18 — Documentation restructure

- Added `brain/architecture/changelog.md` (this file) as the canonical change log.
- Renamed `conversation-protocol-spec.md` → `conversation-protocol-spec-v3.md` to match the versioned filename convention already used throughout `interview-spec-v2.md`.
- Updated `brain/tasks/README.md` to reflect its purpose for ongoing feature work (initial build tasks are complete).
- CLAUDE.md updated to reference the corrected spec filename and the new changelog pattern.

---

## 2026-04-05 — Initial build complete

**What shipped:**
- Full API layer: Fastify + Apollo Server, all GraphQL resolvers, Prisma schema + migrations
- Full frontend: Next.js 15, admin UI, interview UI, all hooks (`useInterviewState`, `usePTT`, `useSSE`)
- All three Lambda handlers: cleaning, reconciliation, user-sync
- All three CDK stacks (FoundationStack, DataStack, ComputeStack): coded, `cdk synth` passes, not yet deployed to AWS
- CI/CD pipelines: `ci.yml`, `deploy-dev.yml`, `deploy-seandev.yml`, `_deploy-ec2-env.yml`
- Two EC2 dev environments live: `appv1` (ports 3000/3001) and `seandev` (ports 3010/3011)

**Decisions made (see ADRs for full rationale):**
- ADR 001: Multi-developer EC2 pattern — port blocks of 10, per-env nginx vhosts, PM2, Docker Compose isolation
- ADR 002: User-sync Lambda placed in FoundationStack to avoid CDK cross-stack circular dependency on Cognito triggers
- ADR 003: Audio upload mutations removed from schema until S3 infrastructure is confirmed working
- ADR 004: EC2 + nginx + PM2 is the permanent deployment target — ECS Fargate/ALB/ECR stripped from CDK

**Known gaps at completion:**
- Audio upload via S3 presigned URLs: not implemented (ADR 003)
- CDK stacks: never deployed to AWS
- Frontend test coverage: smoke tests only
