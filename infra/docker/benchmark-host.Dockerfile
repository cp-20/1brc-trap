FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9 AS builder
ARG NODE_VERSION=24.18.0
ARG NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/* && \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - && mkdir /opt/node && \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
ENV PATH="/opt/node/bin:${PATH}"
WORKDIR /build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate && pnpm install --frozen-lockfile --filter @1brc/runner... && pnpm --filter @1brc/runner build

FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates docker.io openssh-server xz-utils curl && rm -rf /var/lib/apt/lists/* && \
    mkdir -p /run/sshd /var/lib/1brc/jobs /var/lib/1brc/data /var/lib/1brc/work && \
    useradd --create-home --shell /bin/bash onebrc && echo 'onebrc:onebrc' | chpasswd && \
    usermod -aG docker onebrc && chown -R onebrc:onebrc /var/lib/1brc && chmod 1777 /var/lib/1brc/work && \
    printf '\nMatch User onebrc\n  PasswordAuthentication yes\n  ForceCommand /usr/local/bin/onebrc-runner\n  AllowTcpForwarding no\n  X11Forwarding no\n  PermitTTY no\n' >> /etc/ssh/sshd_config
COPY --from=builder /opt/node /opt/node
COPY --from=builder /build/apps/runner/dist /opt/1brc/runner
COPY apps/runner/image /opt/1brc/image-context/apps/runner/image
COPY infra/docker/onebrc-runner /usr/local/bin/onebrc-runner
COPY infra/docker/benchmark-host-entrypoint /usr/local/bin/benchmark-host-entrypoint
RUN chmod 0755 /usr/local/bin/onebrc-runner /usr/local/bin/benchmark-host-entrypoint
ENV PATH="/opt/node/bin:${PATH}" RUNNER_ROOT=/var/lib/1brc RUNNER_IMAGE=onebrc-runner:ubuntu26
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/benchmark-host-entrypoint"]
