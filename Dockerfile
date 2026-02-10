FROM node:22-slim

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Run the indexer using tsx (TypeScript executor)
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
