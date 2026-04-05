# ADR 001 — Multi-Developer Environment Pattern on Shared EC2

**Date:** 2026-04-05
**Status:** Accepted

## Context

Multiple developers need isolated environments to work on Arena simultaneously. A shared EC2
instance is the host. Each environment needs its own domain, database, and processes without
interfering with others. EC2 is the permanent deployment model (see ADR 004).

## Decision

Each developer environment gets:

1. **A port block of 10** — frontend on `N`, API on `N+1`. Blocks increment by 10:
   - appv1: 3000/3001
   - seandev: 3010/3011
   - (next): 3020/3021

2. **An nginx vhost** at `/etc/nginx/sites-available/<envname>` routing by subdomain
   (`<envname>.elastichorizon.com`) to the assigned ports.

3. **A Let's Encrypt cert** per subdomain, managed by certbot with auto-renewal.

4. **Isolated Postgres and Redis** via Docker Compose with offset host ports:
   - Postgres: 5432 (appv1), 5433 (seandev), 5434 (next), ...
   - Redis: 6379 (appv1), 6380 (seandev), 6381 (next), ...

5. **PM2 processes** named `<envname>-api` and `<envname>-frontend`, persisted via
   `pm2 save` and `pm2 startup`.

6. **A deploy workflow** — `.github/workflows/deploy-<envname>.yml` — that calls the
   reusable `_deploy-ec2-env.yml` with the environment's path and PM2 names.

## Port registry

Maintained in `docs/dev-environments.md`. **Always claim a port block in that file before
starting a new environment.**

## Alternatives considered

- **One environment per EC2** — too expensive for dev environments; environments are
  short-lived.
- **Docker Compose for the whole app** — adds complexity for live dev with hot reload;
  the current PM2 + host nginx pattern matches how developers work.
- **Sequential port numbers** (3000, 3001, 3002, 3003...) — rejected because it makes
  the frontend/API pairing ambiguous at a glance; blocks of 10 are self-documenting.
