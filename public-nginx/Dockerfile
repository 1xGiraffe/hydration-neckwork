# Micro-cache sidecar for the public REST API. No build stage and no static
# files: it only proxies and caches `api-public`.
# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
# 1.31.10 (2026-11-23) taken inside the 14-day release cooldown by an explicit decision on
# 2026-11-24: it carries the November security releases (1.31.9 "nginx2root" and follow-ups).
FROM nginx:1.31.10-alpine@sha256:aceb952b920393b7d0bc7b978927fc283370bea89fb082c6fef0ce18c60f96a9

COPY nginx.conf /etc/nginx/conf.d/default.conf

# Unprivileged: UID 10001 (reserved for the stack's containers, see docker-compose.yml's
# x-hardened). Master and workers run as it — no `user` switch; the pid file
# (/run) and the cache and temp dirs (/var/cache/nginx) are tmpfs mounts owned by it, the
# root filesystem is read-only (docker-compose.yml). Port 80 binds unprivileged inside
# the container's network namespace.
RUN sed -i '/^user /d' /etc/nginx/nginx.conf \
 && touch /etc/nginx/rate-exempt.local.conf
USER 10001:10001

EXPOSE 80
