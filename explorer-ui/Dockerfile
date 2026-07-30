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
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
