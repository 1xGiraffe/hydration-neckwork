# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

WORKDIR /app

# Copy package files for dependency installation
COPY --chown=node:node package.json package-lock.json ./

# Install production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy source code
COPY --chown=node:node src/ ./src/

# Default to the price indexer CLI, but allow compose to override the script path.
USER node
ENTRYPOINT ["./node_modules/.bin/tsx"]
CMD ["src/cli.ts"]
