# Express API image. Build from the REPO ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile -t orderko-api .
#
# The monorepo layout is preserved inside the image because the setup script
# reads db/schema.sql and db/seed.sql relative to the repo root.

FROM node:20-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --omit=dev --no-audit --fund=false


FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Run as the image's existing unprivileged user rather than root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node db ./db

USER node
WORKDIR /app/apps/api

# Hosts that inject their own PORT will override this.
ENV PORT=4000
EXPOSE 4000

# The platform's own health check should hit /api/health, which reports
# whether the database is reachable as well as whether the process is up.
CMD ["node", "src/index.js"]
