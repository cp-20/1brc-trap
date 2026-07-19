# syntax=docker/dockerfile:1.7

FROM oven/bun@sha256:81901a85056114eab0c695db71703a73cae26284c8688d199cd39af452dd0f8b AS bun

FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9 AS bun-base
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /opt/bun/bin/bun
ENV PATH="/opt/bun/bin:${PATH}"

FROM bun-base AS manifests
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/mock-auth/package.json ./apps/mock-auth/package.json
COPY apps/runner/package.json ./apps/runner/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY infra/cdk/package.json ./infra/cdk/package.json

FROM manifests AS production-dependencies
RUN --mount=type=cache,id=onebrc-bun,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --production --ignore-scripts \
      --filter './apps/server' \
      --filter './packages/domain'

FROM production-dependencies AS dependencies
RUN --mount=type=cache,id=onebrc-bun,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --ignore-scripts \
      --filter '.' \
      --filter './apps/mock-auth' \
      --filter './apps/server' \
      --filter './apps/web' \
      --filter './packages/domain'

FROM dependencies AS backend-builder
COPY packages/domain ./packages/domain
COPY apps/mock-auth ./apps/mock-auth
COPY apps/server ./apps/server
RUN bun run --parallel \
      --filter @1brc/domain \
      --filter @1brc/mock-auth \
      --filter @1brc/server \
      build

FROM dependencies AS web-builder
COPY packages/domain ./packages/domain
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN bun run --filter @1brc/web build

FROM bun-base
RUN groupadd --system --gid 10001 onebrc && useradd --system --uid 10001 --gid onebrc --home /app onebrc
WORKDIR /app
COPY --chmod=0755 infra/docker/app-entrypoint /usr/local/bin/app-entrypoint
COPY --from=production-dependencies --chown=onebrc:onebrc /app /app
COPY --from=backend-builder --chown=onebrc:onebrc /app/packages/domain/src ./packages/domain/src
COPY --from=backend-builder --chown=onebrc:onebrc /app/apps/mock-auth/dist ./apps/mock-auth/dist
COPY --from=backend-builder --chown=onebrc:onebrc /app/apps/server/dist ./apps/server/dist
COPY --from=backend-builder --chown=onebrc:onebrc /app/apps/server/migrations ./apps/server/migrations
COPY --from=web-builder --chown=onebrc:onebrc /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production STATIC_ROOT=/app/apps/web/dist
USER onebrc
EXPOSE 3000 6499
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["/opt/bun/bin/bun", "--smol", "/app/apps/server/dist/bundle/index.js"]
