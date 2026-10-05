FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

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

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared include for the page-URL locations (see seo_page.conf's own comment).
COPY seo_page.conf /etc/nginx/seo_page.conf
COPY --from=build /app/bundle_id.conf /etc/nginx/bundle_id.conf

EXPOSE 80
