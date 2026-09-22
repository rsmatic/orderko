# Builds the React app and serves it behind Caddy, which also proxies /api to
# the API container. Because both live on one origin there is no CORS to
# configure and VITE_API_BASE_URL can stay at its default.
#
# Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t orderko-web .

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci --no-audit --fund=false

COPY apps/web ./apps/web
# Served from the domain root behind Caddy, so no sub-path and no demo backend.
ENV VITE_BASE=/
ENV VITE_DEMO=0
RUN npm run build --workspace apps/web


FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
