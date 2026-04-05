# ADR 004 — EC2 as Permanent Deployment Target

**Status:** Accepted  
**Date:** 2026-04-05

---

## Context

The CDK infrastructure includes a full `ComputeStack` with an ECS Fargate cluster, an
Application Load Balancer with path-based routing, API and Frontend Fargate services with
auto-scaling, and ECR repositories. These were scaffolded as the intended production
deployment target but were never deployed to AWS.

The existing deployment model — two EC2 environments (appv1, seandev) with host-level nginx
terminating TLS and PM2 managing Node processes — is fully functional and serves the current
needs of the platform.

---

## Decision

Stay on EC2 with nginx + PM2 as the deployment model. Fargate, ALB, and ECR are not
needed at this stage and will not be pursued.

---

## Rationale

- **Iteration speed:** No container rebuild cycle. A code change is `git pull` + `pm2 restart`.
  Fargate would require Docker build → ECR push → ECS force-new-deployment on every change.
- **Cost:** Fargate minimums (2 tasks each for API + Frontend) cost meaningfully more than
  a single EC2 instance running all environments.
- **Debugging:** Direct SSH access; `pm2 logs` shows everything in real time. ECS requires
  CloudWatch Logs or ECS Exec to inspect a running container.
- **Scale mismatch:** Fargate's autoscaling (2–4 API tasks at 70% CPU) provides no benefit
  at current traffic levels.

---

## Consequences

- `cd.yml` (ECS deploy workflow) and `deploy.yml` (ECS placeholder workflow) deleted.
- `ci.yml` stripped to test jobs only (Docker build and ECR push jobs removed).
- `ComputeStack` Fargate/ALB/ECR sections removed; only SQS + Lambda + EventBridge remain.
- `FoundationStack` ECR repositories and ALB security group removed; `ecsSg` renamed to
  `lambdaSg` (outbound-only, for VPC-bound Lambdas).
- CDK deploy scope is now: FoundationStack (Cognito, user-sync Lambda, S3) + DataStack
  (RDS, ElastiCache) + ComputeStack (cleaning Lambda, reconciliation Lambda, SQS).
- The `api/Dockerfile` and `frontend/Dockerfile` are retained for local Docker builds but
  are not part of any CI/CD pipeline.

---

## Supersedes

ADR 001 describes the multi-env EC2 pattern as "before ECS production stack is deployed."
That qualifier no longer applies — EC2 is the production deployment model, not a bridge.
