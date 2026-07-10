FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9 AS ruby-builder

ARG RUBY_VERSION=4.0.5
ARG RUBY_SHA256=5dc5521ea54c726e6cc10b1b5a0f4004b27b482e61c04c99aed79315e30895e5
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl xz-utils autoconf bison libssl-dev libyaml-dev \
    libreadline-dev zlib1g-dev libffi-dev libgdbm-dev rustc && \
    rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/ruby.tar.xz "https://cache.ruby-lang.org/pub/ruby/4.0/ruby-${RUBY_VERSION}.tar.xz" && \
    echo "${RUBY_SHA256}  /tmp/ruby.tar.xz" | sha256sum -c - && \
    mkdir /tmp/ruby && tar -xJf /tmp/ruby.tar.xz -C /tmp/ruby --strip-components=1 && \
    cd /tmp/ruby && ./configure --prefix=/opt/ruby --disable-install-doc && \
    make -j"$(nproc)" && make install

FROM ubuntu:26.04@sha256:c6c0067e0e45b7a826eaebb193cef957be28045380963a9b1eeb2a5d3c70a1b9

ARG NODE_VERSION=24.18.0
ARG NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils libstdc++6 libgcc-s1 zlib1g libssl3t64 libyaml-0-2 libreadline8t64 \
    libffi8 libgdbm6t64 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - && \
    mkdir /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
COPY --from=ruby-builder /opt/ruby /opt/ruby
COPY apps/runner/image/measure.mjs /opt/1brc/measure.mjs
ENV PATH="/opt/node/bin:/opt/ruby/bin:${PATH}" LANG=C.UTF-8
RUN useradd --no-create-home --uid 65534 runner 2>/dev/null || true
USER 65534:65534
WORKDIR /work
