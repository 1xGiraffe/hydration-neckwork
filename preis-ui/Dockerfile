FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Build-time URL of the sibling Explorer UI, inlined by Vite into the bundle
# (import.meta.env.VITE_EXPLORER_URL). Must be set at BUILD time, not runtime; the
# source defaults to localhost:5174 if unset. Supplied via docker-compose build.args.
ARG VITE_EXPLORER_URL
ENV VITE_EXPLORER_URL=$VITE_EXPLORER_URL
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
