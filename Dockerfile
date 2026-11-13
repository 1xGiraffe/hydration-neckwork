# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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
