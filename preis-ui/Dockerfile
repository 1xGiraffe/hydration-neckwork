# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
# Build-time URL of the sibling Explorer UI, inlined by Vite into the bundle
# (import.meta.env.VITE_EXPLORER_URL). Must be set at BUILD time, not runtime; the
# source defaults to localhost:5174 if unset. Supplied via docker-compose build.args.
ARG VITE_EXPLORER_URL
ENV VITE_EXPLORER_URL=$VITE_EXPLORER_URL
RUN npm run build

FROM nginx:1.31.3-alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared include for the API-rendered locations (see preis_seo.conf).
COPY preis_seo.conf /etc/nginx/preis_seo.conf

EXPOSE 80
