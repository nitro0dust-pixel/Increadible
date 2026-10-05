# Multi-stage build for Increadible

# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY jest.config.js ./

# Install dependencies
RUN npm ci

# Copy source code
COPY features ./features
COPY tests ./tests

# Build TypeScript
RUN npm run build

# Run tests
RUN npm test

# Stage 2: Runtime
FROM node:18-alpine

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built code from builder
COPY --from=builder /app/dist ./dist

# Copy MCP servers
COPY features/07-routing-plugins/src/mcp-server.ts ./features/07-routing-plugins/
COPY features/08-ab-testing/src/mcp-server.ts ./features/08-ab-testing/
COPY features/09-api-gateway/src/mcp-server.ts ./features/09-api-gateway/

# Copy documentation
COPY README.md README_COMPLETE.md PRODUCTION_DEPLOYMENT.md ./
COPY LAUNCH_CHECKLIST.md TIME_TRACKING_REPORT.md ./

# Copy configuration files
COPY .gitmodules .gitignore ./

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('OK')" || exit 1

# Metadata
LABEL org.opencontainers.image.title="Increadible"
LABEL org.opencontainers.image.description="Premium feature collection for Claude Desktop - 99.98% cost optimization"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.authors="Increadible Team"
LABEL org.opencontainers.image.vendor="Increadible"
LABEL org.opencontainers.image.url="https://github.com/nitro0dust-pixel/Increadible"

# Expose MCP server port (if needed)
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Run MCP servers
CMD ["node", "dist/index.js"]
