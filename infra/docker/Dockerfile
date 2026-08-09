# hokago — one build, three entrypoints (api + worker + web).
#
# The worker "owns all ffmpeg" — the binary is built once here and lives in
# every stage of this image, not a separate Dockerfile.

# ── Stage: ffmpeg-builder — CPU-only, --enable-chromaprint is non-negotiable ──
FROM debian:bookworm-slim AS ffmpeg-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config yasm nasm git ca-certificates \
      libssl-dev autoconf automake libtool wget \
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
    && cd opus && ./autogen.sh && ./configure --enable-static --disable-shared \
    && make -j"$(nproc)" && make install

# zimg — backs the zscale filter, load-bearing for HDR->SDR tone-mapping.
RUN git clone --depth 1 --branch release-3.0.6 https://github.com/sekrit-twc/zimg.git \
    && cd zimg && ./autogen.sh && ./configure --enable-static --disable-shared \
    && make -j"$(nproc)" && make install

# ffmpeg itself — CPU only, no vaapi/qsv/nvenc/rkmpp (those are the hwaccel
# overlay, later in the build order; this is the always-works floor).
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

# ── Stage: runtime ──
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe

WORKDIR /repo
COPY --from=node-builder /repo /repo

# entrypoint chosen per service via `command:` in docker-compose.yml (same
# image, different entrypoint — hokago runs apps/api, hokago-worker runs apps/worker)
CMD ["node", "apps/api/dist/index.js"]

# ── Stage: web — nginx serving the SPA, proxying API prefixes to `hokago` ──
FROM nginx:alpine AS web

COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=node-builder /repo/apps/web/dist /usr/share/nginx/html
