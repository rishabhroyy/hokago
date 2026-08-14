# hokago — one build, three entrypoints (api + worker + web).
#
# The worker "owns all ffmpeg" — the binary is built once here and lives in
# every stage of this image, not a separate Dockerfile.
#
# Base: Ubuntu noble (24.04). Debian bookworm/trixie don't ship the Intel
# userspace VAAPI driver (intel-media-va-driver) or oneVPL (libvpl) — they're
# Ubuntu-universe amd64 packages. Node comes from the official tarball in the
# runtime stage; the node-builder stage keeps the official node image.

# ── Stage: ffmpeg-builder — CPU + hardware accel (vaapi/qsv/nvenc) ──
# --enable-chromaprint is non-negotiable. hwaccel support is gated on
# TARGETARCH=amd64 (the x86 stack: libva/oneVPL/nv-codec-headers); arm64
# builds stay CPU-only — detection at boot then falls back to CPU, which is
# the always-works floor. The GPU itself is only reachable via the compose
# overlay (infra/hwaccel.*.yml) that mounts /dev/dri (or the nvidia runtime) —
# absent that mount, detection finds no device and the pipeline stays CPU.
FROM ubuntu:noble AS ffmpeg-builder
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config yasm nasm git ca-certificates \
      libssl-dev autoconf automake libtool wget \
      libva-dev libdrm-dev \
    && if [ "$TARGETARCH" = "amd64" ]; then \
         apt-get install -y --no-install-recommends libvpl-dev; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# libchromaprint — static, no bundled fpcalc (that needs ffmpeg; circular, skip it)
RUN git clone --depth 1 --branch v1.5.1 https://github.com/acoustid/chromaprint.git \
    && cmake -S chromaprint -B chromaprint/build \
         -DCMAKE_BUILD_TYPE=Release \
         -DBUILD_SHARED_LIBS=OFF \
         -DBUILD_TOOLS=OFF \
         -DBUILD_TESTS=OFF \
    && cmake --build chromaprint/build -j"$(nproc)" \
    && cmake --install chromaprint/build

# codec libs ffmpeg links against
RUN git clone --depth 1 --branch stable https://code.videolan.org/videolan/x264.git \
    && cd x264 && ./configure --enable-static --enable-pic --disable-opencl \
    && make -j"$(nproc)" && make install

RUN git clone --depth 1 --branch 4.1 https://bitbucket.org/multicoreware/x265_git.git \
    && cmake -S x265_git/source -B x265_git/build \
         -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF \
    && cmake --build x265_git/build -j"$(nproc)" \
    && cmake --install x265_git/build

RUN git clone --depth 1 --branch v1.14.1 https://github.com/webmproject/libvpx.git \
    && cd libvpx && ./configure --enable-static --disable-shared --disable-examples \
         --disable-unit-tests --enable-pic \
    && make -j"$(nproc)" && make install

RUN git clone --depth 1 --branch v1.5.2 https://github.com/xiph/opus.git \
    && cd opus \
    # autogen.sh runs dnn/download_model.sh, which pulls the DRED model (156M)
    # from media.xiph.org — regularly down/blocked, kills clean builds. The
    # model only feeds DRED decode + tests nothing here runs: stub the script
    # so autogen skips the download and the static lib builds identically.
    && printf '#!/bin/sh\nexit 0\n' > dnn/download_model.sh \
    && ./autogen.sh && ./configure --enable-static --disable-shared \
    && make -j"$(nproc)" && make install

# zimg — backs the zscale filter, load-bearing for HDR->SDR tone-mapping.
RUN git clone --depth 1 --branch release-3.0.6 https://github.com/sekrit-twc/zimg.git \
    && cd zimg && ./autogen.sh && ./configure --enable-static --disable-shared \
    && make -j"$(nproc)" && make install

# nv-codec-headers — the NVIDIA encoder/decoder API headers (not packaged in
# Ubuntu). Header-only; ffmpeg links the driver's .so's at runtime via the
# nvidia-container-toolkit, so nothing extra is needed at runtime.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      git clone --depth 1 --branch n12.2 https://github.com/FFmpeg/nv-codec-headers.git \
      && cd nv-codec-headers && make install; \
    fi

# ffmpeg itself — CPU always works; vaapi/qsv/nvenc are compile-time support
# that the runtime stage's driver libs + the compose overlay make usable.
# rkmpp is intentionally absent (no Rockchip target yet).
RUN git clone --depth 1 --branch n7.1 https://github.com/FFmpeg/FFmpeg.git ffmpeg \
    && cd ffmpeg && PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
         --pkg-config-flags="--static" \
         --extra-libs="-lpthread -lm -lstdc++" \
         --enable-gpl \
         --enable-version3 \
         --enable-static \
         --disable-shared \
         --disable-doc \
         --disable-debug \
         --enable-chromaprint \
         --enable-libx264 \
         --enable-libx265 \
         --enable-libvpx \
         --enable-libopus \
         --enable-libzimg \
         $(if [ "$TARGETARCH" = "amd64" ]; then \
           echo "--enable-vaapi --enable-qsv --enable-libvpl --enable-nvenc --enable-ffnvcodec"; \
         fi) \
    && make -j"$(nproc)" && make install

# ── Stage: node-builder — pnpm workspace build ──
FROM node:22-bookworm-slim AS node-builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile=false

# Codegen is deterministic: generated dirs are gitignored and come along in the
# COPY above (host artifacts, e.g. the macOS query engine). prisma generate does
# not clean its output, so stale engines would be shipped. Wipe before regenerating.
RUN rm -rf packages/db/generated packages/contract/generated packages/fonts/vendor \
    && pnpm --filter @hokago/contract generate \
    && pnpm --filter @hokago/db generate \
    && pnpm --filter @hokago/fonts build \
    && pnpm -r build

# ── Stage: runtime — one container for API + SPA (web routes served by the
# API itself via HOKAGO_WEB_ROOT; nginx removed — no proxy config to drift).
# Ubuntu base so the Intel/AMD VAAPI userspace drivers are apt-installable
# (intel-media-va-driver / mesa-va-drivers / libvpl2 don't exist in Debian);
# node comes from the official tarball (no official ubuntu node image). ──
FROM ubuntu:noble AS runtime
ARG TARGETARCH
# Keep in step with the node:22 images the node-builder stage uses.
ARG NODE_VERSION=22.23.2

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl xz-utils \
      # hwaccel user-space drivers: libva + iHD (Intel) / radeonsi (AMD) for
      # vaapi/qsv, libvpl2 for the qsv dispatcher. nvenc needs no package —
      # the nvidia-container-toolkit mounts the driver .so's at container
      # start. x86-only packages are gated on TARGETARCH (arm64 = CPU).
      libva2 libva-drm2 mesa-va-drivers \
    && if [ "$TARGETARCH" = "amd64" ]; then \
         apt-get install -y --no-install-recommends libvpl2 intel-media-va-driver; \
       fi \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${TARGETARCH}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe

WORKDIR /repo
COPY --from=node-builder /repo /repo
COPY --from=node-builder /repo/apps/web/dist /app/web

# entrypoint chosen per service via `command:` in docker-compose.yml (same
# image, different entrypoint — hokago runs apps/api, hokago-worker runs apps/worker)
CMD ["node", "apps/api/dist/index.js"]