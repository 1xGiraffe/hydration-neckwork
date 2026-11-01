# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

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
# Bundle identity for the SEO page handshake (seo_page.conf, api/src/routes/seo.ts):
# the hash of the entry chunk this image's index.html loads, as an nginx variable.
# The build fails rather than ship an image whose renderer cannot be checked.
RUN id=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1 | sed -E 's#^/assets/index-(.*)\.js$#\1#') \
 && test -n "$id" \
 && printf 'set $bundle_id "%s";\n' "$id" > /app/bundle_id.conf \
 && cat /app/bundle_id.conf

FROM nginx:1.31.3-alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared include for the page-URL locations (see seo_page.conf's own comment).
COPY seo_page.conf /etc/nginx/seo_page.conf
COPY --from=build /app/bundle_id.conf /etc/nginx/bundle_id.conf

EXPOSE 80
