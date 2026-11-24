# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build

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

# 1.31.10 (2026-11-23) taken inside the 14-day release cooldown by an explicit decision on
# 2026-11-24: it carries the November security releases (1.31.9 "nginx2root" and follow-ups).
FROM nginx:1.31.10-alpine@sha256:aceb952b920393b7d0bc7b978927fc283370bea89fb082c6fef0ce18c60f96a9

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared include for the API-rendered locations (see preis_seo.conf).
COPY preis_seo.conf /etc/nginx/preis_seo.conf

# Unprivileged: UID 10001 (reserved for the stack's containers, see docker-compose.yml's
# x-hardened). Master and workers run as it — no `user` switch; the pid file
# (/run) and the cache and temp dirs (/var/cache/nginx) are tmpfs mounts owned by it, the
# root filesystem is read-only (docker-compose.yml). Port 80 binds unprivileged inside
# the container's network namespace.
RUN sed -i '/^user /d' /etc/nginx/nginx.conf \
 && touch /etc/nginx/rate-exempt.local.conf
USER 10001:10001

EXPOSE 80
