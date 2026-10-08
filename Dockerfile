# syntax=docker/dockerfile:1
# rproxy-ui のコンテナイメージ（Kubernetes の chart charts/rproxy-ui。docs/KUBERNETES.md）。
# next build の standalone（.deb と同じもの）と db/（schema.sql・migrations・migrate.mjs・node-view.mjs）を node:24-alpine に入れる。
# ネイティブなモジュールを入れないので、JS はビルドするマシンで 1 回だけ作り、amd64・arm64 の両方のイメージに同じものを入れる。
# 実行は uid 65532、ルートは読むだけでよい（書くのは /tmp と /app/.next/cache だけ。chart は emptyDir を付ける）。
ARG NODE_IMAGE=node:24-alpine

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
	&& rm -rf .next/standalone/node_modules/@img .next/standalone/node_modules/sharp \
	&& find .next/standalone -maxdepth 1 -name '.env*' -delete \
	&& if [ -n "$(find .next/standalone -name '*.node' -print -quit)" ]; then \
		echo "native modules found; the image would differ per CPU:" >&2; find .next/standalone -name '*.node' >&2; exit 1; \
	fi \
	&& rm -rf .next/standalone/.next/cache

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="rproxy-ui" \
	org.opencontainers.image.description="web UI for rproxy-api" \
	org.opencontainers.image.source="https://github.com/max3584/TCP-UDP-rproxy-ui" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}"
RUN addgroup -S -g 65532 rproxy-ui && adduser -S -D -H -u 65532 -G rproxy-ui -s /sbin/nologin rproxy-ui
WORKDIR /app
COPY --from=build /src/.next/standalone/ ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY --from=build /src/db ./db
# the cache is the only place the server writes under /app (an emptyDir in the chart; writable here without one)
RUN mkdir -p .next/cache && chown 65532:65532 .next/cache
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
USER 65532:65532
EXPOSE 3000
CMD ["node", "server.js"]
