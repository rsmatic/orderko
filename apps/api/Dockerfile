# Express API image. Build from the REPO ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile -t orderko-api .
#
# The monorepo layout is preserved because the API imports @overnight-oats/core
# from the workspace.

FROM node:20-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --omit=dev --no-audit --fund=false


FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Run as the image's existing unprivileged user rather than root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/core ./packages/core
COPY --chown=node:node apps/api ./apps/api

# The whole database is one JSON file. Mount a volume here or every order is
# lost when the container is replaced.
RUN mkdir -p /app/apps/api/data && chown -R node:node /app/apps/api/data
VOLUME ["/app/apps/api/data"]

USER node
WORKDIR /app/apps/api

ENV PORT=4000
EXPOSE 4000

# The platform's health check should hit /api/health.
CMD ["node", "src/index.js"]
