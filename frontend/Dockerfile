# ── Stage 1: Base ──────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app

# ── Stage 2: Dependencies ─────────────────────────────────────
FROM base AS deps

# libc6-compat needed for native modules on Alpine
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ── Stage 3: Builder ──────────────────────────────────────────
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ensure public dir exists so COPY in runner stage never fails
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 4: Runner ───────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy public assets
COPY --from=builder /app/public ./public

# Create .next directory with proper ownership
RUN mkdir .next && chown nextjs:nodejs .next

# Copy standalone server and static assets
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server.js"]
