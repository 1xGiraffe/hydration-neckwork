# Micro-cache sidecar for the public REST API. No build stage and no static
# files: it only proxies and caches `api-public`.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
