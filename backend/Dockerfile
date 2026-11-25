# syntax=docker/dockerfile:1
# ---- build stage: full dependencies + TypeScript compile ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production dependencies only, non-root ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seeds ./seeds
COPY scripts ./scripts
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run on every start (idempotent), then the API. Free hosts have no release step or shell.
CMD ["sh", "-c", "npx node-pg-migrate -m migrations -j sql up && node dist/server.js"]
