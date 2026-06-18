# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  AIRLOCK_CONFIG=/config/airlock.yaml \
  AIRLOCK_HEALTH_HOST=127.0.0.1 \
  AIRLOCK_HEALTH_PORT=4111 \
  NPM_CONFIG_CACHE=/home/airlock/.npm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini bash \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 airlock \
  && useradd --system --uid 10001 --gid airlock --home-dir /home/airlock --create-home --shell /usr/sbin/nologin airlock \
  && mkdir -p /config /data /home/airlock/.npm \
  && chown -R airlock:airlock /config /data /home/airlock

COPY --from=build --chown=airlock:airlock /app/dist ./dist
COPY --from=build --chown=airlock:airlock /app/node_modules ./node_modules
COPY --from=build --chown=airlock:airlock /app/package.json ./package.json
COPY --chown=airlock:airlock schema.json ./schema.json
COPY --chown=airlock:airlock examples ./examples
COPY --chown=airlock:airlock extensions ./extensions
COPY docker/entrypoint.sh /usr/local/bin/airlock-entrypoint
COPY docker/healthcheck.mjs /usr/local/bin/airlock-healthcheck.mjs

RUN chmod 0755 /usr/local/bin/airlock-entrypoint /usr/local/bin/airlock-healthcheck.mjs

USER airlock

VOLUME ["/config", "/data"]
EXPOSE 4111 4112

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/bin/airlock-healthcheck.mjs"]

ENTRYPOINT ["tini", "--", "airlock-entrypoint"]
CMD []
