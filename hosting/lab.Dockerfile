FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/tools
COPY tools/package.json tools/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts --min-release-age=14

ENV DIR_TO_DOWNLOAD_BINARY=/opt/sandbox
RUN node --input-type=module -e 'import { Sandbox } from "near-sandbox"; const sandbox = await Sandbox.start({}); await sandbox.tearDown();'
COPY tools/src ./src
COPY fixtures /app/fixtures
COPY SPEC.md spec-source.json /app/
RUN chmod -R a+rX /app/fixtures /app/tools/src /app/SPEC.md /app/spec-source.json
ARG LAB_SOURCE_REVISION
LABEL org.opencontainers.image.revision=$LAB_SOURCE_REVISION
ENV NODE_ENV=production LAB_HOST=0.0.0.0 LAB_PORT=8791
USER node
EXPOSE 8791
CMD ["node", "--import", "tsx", "src/lab/main.ts"]
