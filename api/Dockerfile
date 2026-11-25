# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3000

# Runs as UID 10001 (reserved for the stack's containers, see docker-compose.yml's
# x-hardened), not the base image's `node` (UID 1000, often the host's first login
# user). The code and node_modules stay root-owned: readable, never writable, by the
# process that runs them; it writes only under /tmp.
USER 10001:10001
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
