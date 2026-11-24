# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
# Build-time URL of the Preis price-chart UI, inlined by Vite into the bundle
# (import.meta.env.VITE_PREIS_URL). Must be set at BUILD time, not runtime; the
# source defaults to localhost:5173 if unset. Supplied via docker-compose build.args.
ARG VITE_PREIS_URL
ENV VITE_PREIS_URL=$VITE_PREIS_URL
# Browser-side EVM JSON-RPC endpoint (contract tab bytecode + eth_call reads).
# Defaults to https://hydration-rpc.neckwork.net in src/evmRpc.ts if unset.
ARG VITE_EVM_RPC_URL
ENV VITE_EVM_RPC_URL=$VITE_EVM_RPC_URL
RUN npm run build
# A gzip copy of every text asset at the highest level, beside the original, for
# nginx's gzip_static (nginx.conf): served as is, never compressed per request.
# Node's own zlib, so the build needs no compressor package. A copy no smaller
# than the original is not kept.
RUN node -e "const fs=require('fs'),z=require('zlib'),p=require('path');const d='dist/assets';let n=0;for(const f of fs.readdirSync(d)){if(!/\\.(js|css|svg|json)$/.test(f))continue;const b=fs.readFileSync(p.join(d,f));if(b.length<1024)continue;const g=z.gzipSync(b,{level:9});if(g.length<b.length){fs.writeFileSync(p.join(d,f+'.gz'),g);n++}}console.log('precompressed',n,'assets')"
# Bundle identity for the SEO page handshake (seo_page.conf, api/src/routes/seo.ts):
# the hash of the entry chunk this image's index.html loads, as an nginx variable.
# The build fails rather than ship an image whose renderer cannot be checked.
RUN id=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1 | sed -E 's#^/assets/index-(.*)\.js$#\1#') \
 && test -n "$id" \
 && printf 'set $bundle_id "%s";\n' "$id" > /app/bundle_id.conf \
 && cat /app/bundle_id.conf

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
COPY --from=build /app/csp_script_hash /tmp/csp_script_hash
RUN sed -i "s|__CSP_SCRIPT_HASH__|$(cat /tmp/csp_script_hash)|" /etc/nginx/conf.d/default.conf \
 && ! grep -q __CSP_SCRIPT_HASH__ /etc/nginx/conf.d/default.conf \
 && grep -q "script-src 'self' 'sha256-" /etc/nginx/conf.d/default.conf \
 && rm /tmp/csp_script_hash
# Shared include for the page-URL locations (see seo_page.conf's own comment).
COPY seo_page.conf /etc/nginx/seo_page.conf
COPY --from=build /app/bundle_id.conf /etc/nginx/bundle_id.conf

# Unprivileged: UID 10001 (reserved for the stack's containers, see docker-compose.yml's
# x-hardened). Master and workers run as it — no `user` switch; the pid file
# (/run) and the cache and temp dirs (/var/cache/nginx) are tmpfs mounts owned by it, the
# root filesystem is read-only (docker-compose.yml). Port 80 binds unprivileged inside
# the container's network namespace.
RUN sed -i '/^user /d' /etc/nginx/nginx.conf \
 && touch /etc/nginx/rate-exempt.local.conf
USER 10001:10001

EXPOSE 80
