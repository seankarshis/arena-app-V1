# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (devDeps required for Prisma CLI + TypeScript compiler)
RUN npm ci

# Generate Prisma client BEFORE TypeScript compilation so generated types are
# available to tsc. Running after build would produce type errors.
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    # OTel SDK picks these up automatically via auto-instrumentations-node.
    # The collector sidecar runs in the same ECS task on localhost.
    OTEL_SERVICE_NAME=arena-api \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
    OTEL_EXPORTER_OTLP_PROTOCOL=grpc

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the generated Prisma client (contains platform-specific query engine
# binary built in the builder stage against the same alpine image).
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy the Prisma CLI (a devDependency) needed to run `prisma migrate deploy`
# at container startup. Includes the migration engine binary.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# Copy schema + migrations so `prisma migrate deploy` can resolve them.
COPY --from=builder /app/prisma ./prisma

# Copy compiled application
COPY --from=builder /app/dist ./dist

# ── OTel Collector sidecar config ─────────────────────────────────────────────
# Stored in the image at /app/otel-collector-config.yaml.
# Reference this path in the ECS Fargate task definition when configuring the
# AWS Distro for OpenTelemetry (ADOT) sidecar container, e.g. via a shared
# volume or by copying it into the collector image at build time.
#
# The collector receives traces/metrics/logs from the API via gRPC on :4317
# and forwards them to ClickHouse Cloud via the OTLP HTTP endpoint.
# Required env vars on the collector sidecar:
#   CLICKHOUSE_OTLP_ENDPOINT — e.g. https://<host>:4318
#   CLICKHOUSE_AUTH_TOKEN    — base64(user:password)
RUN cat > /app/otel-collector-config.yaml <<'EOF'
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 256
  batch:
    timeout: 5s
    send_batch_size: 1000

exporters:
  otlphttp/clickhouse:
    endpoint: ${CLICKHOUSE_OTLP_ENDPOINT}
    headers:
      authorization: "Basic ${CLICKHOUSE_AUTH_TOKEN}"
    tls:
      insecure: false

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/clickhouse]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/clickhouse]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/clickhouse]
EOF

EXPOSE 3001

# start-period is generous to allow migrations to complete before health checks
# begin; retries cover transient DB connectivity issues at cold start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Apply any pending migrations, then hand off to the Fastify server.
# `exec` replaces the shell so SIGTERM goes directly to node for graceful
# shutdown. If migrate deploy fails the container exits non-zero and ECS
# will not proceed to mark the task healthy.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
