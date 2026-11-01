# Micro-cache sidecar for the public REST API. No build stage and no static
# files: it only proxies and caches `api-public`.
# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM nginx:1.31.3-alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
