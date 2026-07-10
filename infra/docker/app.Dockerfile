FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9 AS node-base
ARG NODE_VERSION=24.18.0
ARG NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/* && \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - && \
    mkdir /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
ENV PATH="/opt/node/bin:${PATH}"

FROM node-base AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate && pnpm install --frozen-lockfile && pnpm build

FROM node-base
RUN groupadd --system --gid 10001 onebrc && useradd --system --uid 10001 --gid onebrc --home /app onebrc
WORKDIR /app
COPY --from=builder --chown=onebrc:onebrc /app /app
ENV NODE_ENV=production STATIC_ROOT=/app/apps/web/dist
USER onebrc
EXPOSE 3000
CMD ["/opt/node/bin/node", "/app/apps/server/dist/index.js"]
