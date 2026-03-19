FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3000

CMD ["npx", "tsx", "src/server.ts"]
