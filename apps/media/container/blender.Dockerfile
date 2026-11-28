# Recipes that need Blender or the image-to-threejs Python pipeline. Built by cf deploy.
FROM node:22-bookworm-slim

ARG BLENDER_SERIES=4.2
ARG BLENDER_VERSION=4.2.23
ARG IMG2THREEJS_TAG=v1.5.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-numpy \
     python3-pil xz-utils libegl1 libgl1 libice6 libsm6 libxfixes3 libxi6 libxkbcommon0 \
     libxrender1 libxxf86vm1 \
  && rm -rf /var/lib/apt/lists/*

ADD https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz /tmp/blender.tar.xz
RUN tar -xJf /tmp/blender.tar.xz -C /opt \
  && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender \
  && rm /tmp/blender.tar.xz

ADD https://github.com/img2threejs/img2threejs/archive/refs/tags/${IMG2THREEJS_TAG}.tar.gz /tmp/img2threejs.tar.gz
RUN mkdir -p /opt/img2threejs \
  && tar -xzf /tmp/img2threejs.tar.gz -C /opt/img2threejs --strip-components=1 \
  && rm /tmp/img2threejs.tar.gz

COPY dist/server.mjs /app/server.mjs

ENV RECIPE_ROOT=/tmp/work PORT=8080 IMG2THREEJS_HOME=/opt/img2threejs
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
