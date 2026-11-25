# Recipes that need ffmpeg or gltf-transform. Built from apps/media/container by cf deploy.
FROM node:22-bookworm-slim

ARG KTX_VERSION=4.3.2
ARG GLTF_TRANSFORM_VERSION=4.5.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tar \
  && rm -rf /var/lib/apt/lists/*

ADD https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.deb /tmp/ktx.deb
RUN apt-get update \
  && apt-get install -y --no-install-recommends /tmp/ktx.deb \
  && rm -rf /var/lib/apt/lists/* /tmp/ktx.deb

RUN npm install --global --omit=dev "@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}" sharp \
  && npm cache clean --force

COPY dist/server.mjs /app/server.mjs

ENV RECIPE_ROOT=/tmp/work PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
