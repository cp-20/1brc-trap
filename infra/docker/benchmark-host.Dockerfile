# syntax=docker/dockerfile:1.7

FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9 AS bun-base
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl unzip libstdc++6 && rm -rf /var/lib/apt/lists/* && \
    curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" && \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - && mkdir -p /opt/bun/bin && \
    unzip -p /tmp/bun.zip bun-linux-x64/bun > /opt/bun/bin/bun && chmod 0755 /opt/bun/bin/bun
ENV PATH="/opt/bun/bin:${PATH}"
WORKDIR /build

FROM bun-base AS dependencies
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/mock-auth/package.json ./apps/mock-auth/package.json
COPY apps/runner/package.json ./apps/runner/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY infra/cdk/package.json ./infra/cdk/package.json
RUN --mount=type=cache,id=onebrc-bun,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --ignore-scripts \
      --filter '.' \
      --filter './apps/runner' \
      --filter './packages/contracts'

FROM dependencies AS builder
COPY packages/contracts ./packages/contracts
COPY apps/runner ./apps/runner
RUN bun run --filter @1brc/runner build

FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates docker.io openssh-server curl libstdc++6 && rm -rf /var/lib/apt/lists/* && \
    mkdir -p /run/sshd /var/lib/1brc/jobs /var/lib/1brc/data /var/lib/1brc/work && \
    useradd --create-home --shell /bin/bash onebrc && echo 'onebrc:onebrc' | chpasswd && \
    usermod -aG docker onebrc && chown -R onebrc:onebrc /var/lib/1brc && chmod 1777 /var/lib/1brc/work && \
    printf '\nMatch User onebrc\n  PasswordAuthentication yes\n  ForceCommand /usr/local/bin/onebrc-runner\n  AllowTcpForwarding no\n  X11Forwarding no\n  PermitTTY no\n' >> /etc/ssh/sshd_config
COPY --from=builder /opt/bun /opt/bun
COPY --from=builder /build/apps/runner/dist /opt/1brc/runner
COPY apps/runner/image /opt/1brc/image-context/apps/runner/image
COPY infra/docker/onebrc-runner /usr/local/bin/onebrc-runner
COPY infra/docker/benchmark-host-entrypoint /usr/local/bin/benchmark-host-entrypoint
RUN chmod 0755 /usr/local/bin/onebrc-runner /usr/local/bin/benchmark-host-entrypoint
ENV PATH="/opt/bun/bin:${PATH}" RUNNER_ROOT=/var/lib/1brc RUNNER_IMAGE=onebrc-runner:ubuntu26
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/benchmark-host-entrypoint"]
