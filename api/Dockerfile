# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node src/ ./src/
COPY --chown=node:node tsconfig.json ./

EXPOSE 3000

USER node
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
