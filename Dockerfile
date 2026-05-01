FROM node:22-slim

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Default to the price indexer CLI, but allow compose to override the script path.
ENTRYPOINT ["npx", "tsx"]
CMD ["src/cli.ts"]
