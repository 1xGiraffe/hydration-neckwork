FROM node:22-slim

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src/ ./src/
COPY --chown=node:node tsconfig.json ./

EXPOSE 3000

USER node
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
