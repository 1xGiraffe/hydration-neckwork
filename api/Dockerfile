# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node src/ ./src/
COPY --chown=node:node tsconfig.json ./

EXPOSE 3000

USER node
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
