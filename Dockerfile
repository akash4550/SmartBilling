# =============================================================================
# Multi-stage Dockerfile for Smart Billing (Next.js 15 + Prisma + PostgreSQL)
#
# Stages:
#   1. deps     — install all node_modules (including dev) for building
#   2. builder  — run Prisma generate + Next.js production build
#   3. runner   — minimal production image with only runtime deps
# =============================================================================

# ----- Stage 1: Dependencies -----
FROM node:20-alpine AS deps
    # 1. ADD PYTHON3, MAKE, AND G++ HERE:
RUN apk add --no-cache libc6-compat openssl python3 make g++
WORKDIR /app
COPY package.json package-lock.json* prisma/schema* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
RUN npx prisma generate
    
    # ----- Stage 2: Build -----
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Copy the rest of the source
COPY . .

# Disable Next.js telemetry & enforce production for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Re-run prisma generate (safe, idempotent) so client matches the schema shipped with code
RUN npx prisma generate
ENV SKIP_ENV_VALIDATION=true
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
# Build Next.js for production
RUN npm run build

# ----- Stage 3: Production Runner -----
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Run as non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy the public folder (static assets)
COPY --from=builder /app/public ./public

# Copy the Next.js standalone output + static assets (if using output: "standalone")
# We use a more compatible approach: copy .next, package.json, node_modules from builder,
# but prune dev deps.
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

# If you later set output: "standalone" in next.config.ts, switch to:
# COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run database migrations on startup (optional but convenient) then start Next.js
# If you prefer to run migrations manually, remove the prisma migrate deploy line.
CMD ["sh", "-c", "npx prisma migrate deploy && node_modules/.bin/next start"]
