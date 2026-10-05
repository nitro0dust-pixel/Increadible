# syntax=docker/dockerfile:1

# ---- build ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY features/07-routing-plugins/src ./features/07-routing-plugins/src
COPY features/08-ab-testing/src ./features/08-ab-testing/src
COPY features/09-api-gateway/src ./features/09-api-gateway/src
COPY scripts/clean.js ./scripts/clean.js
RUN npm run build

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    RULES_FILE=/data/rules.yaml \
    EXPERIMENTS_FILE=/data/experiments.yaml \
    AB_DATA_FILE=/data/ab-data.jsonl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
# Set AUTH_TOKEN at runtime; it protects /mcp and /metrics (health probes stay open).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
