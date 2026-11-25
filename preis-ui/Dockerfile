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

# The CSP's script-src allows index.html's one inline script (the theme bootstrap) by
# its hash instead of 'unsafe-inline'. Every other <script> must load from a file; the
# build fails on a second inline script rather than ship a policy that blocks it.
RUN node -e "const fs=require('fs'),c=require('crypto');const h=fs.readFileSync('dist/index.html','utf8');const tags=[...h.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/g)];const inline=tags.filter(t=>!/\\bsrc=/.test(t[1]));if(inline.length!==1||inline[0][1].trim()!==''){console.error('expected exactly one bare inline <script> in dist/index.html, found',inline.length);process.exit(1)}fs.writeFileSync('/app/csp_script_hash',\"'sha256-\"+c.createHash('sha256').update(inline[0][2],'utf8').digest('base64')+\"'\")" \
 && cat /app/csp_script_hash

# 1.31.10 (2026-11-23) taken inside the 14-day release cooldown by an explicit decision on
# 2026-11-24: it carries the November security releases (1.31.9 "nginx2root" and follow-ups).
FROM nginx:1.31.10-alpine@sha256:aceb952b920393b7d0bc7b978927fc283370bea89fb082c6fef0ce18c60f96a9

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared include for the API-rendered locations (see preis_seo.conf).
COPY preis_seo.conf /etc/nginx/preis_seo.conf
# The security headers (see preis_headers.conf), with the inline script's hash written
# over the CSP placeholder.
COPY preis_headers.conf /etc/nginx/preis_headers.conf
COPY --from=build /app/csp_script_hash /tmp/csp_script_hash
RUN sed -i "s|__CSP_SCRIPT_HASH__|$(cat /tmp/csp_script_hash)|" /etc/nginx/preis_headers.conf \
 && ! grep -q __CSP_SCRIPT_HASH__ /etc/nginx/preis_headers.conf \
 && grep -q "script-src 'self' 'sha256-" /etc/nginx/preis_headers.conf \
 && rm /tmp/csp_script_hash

# Unprivileged: UID 10001 (reserved for the stack's containers, see docker-compose.yml's
# x-hardened). Master and workers run as it — no `user` switch; the pid file
# (/run) and the cache and temp dirs (/var/cache/nginx) are tmpfs mounts owned by it, the
# root filesystem is read-only (docker-compose.yml). Port 80 binds unprivileged inside
# the container's network namespace.
RUN sed -i '/^user /d' /etc/nginx/nginx.conf \
 && touch /etc/nginx/rate-exempt.local.conf
USER 10001:10001

EXPOSE 80
