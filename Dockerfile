FROM node:22-slim

WORKDIR /app

# Copy package files for dependency installation
COPY --chown=node:node package.json package-lock.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY --chown=node:node src/ ./src/
COPY --chown=node:node clickhouse/schema/ ./clickhouse/schema/

# Default to the price indexer CLI, but allow compose to override the script path.
USER node
ENTRYPOINT ["./node_modules/.bin/tsx"]
CMD ["src/cli.ts"]
