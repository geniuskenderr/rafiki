FROM node:14-slim as builder

WORKDIR /workspace

RUN apt update
RUN apt install -y curl

COPY manifests ./
RUN yarn install --immutable

COPY packs ./

CMD ["node", "-r", "./.pnp.cjs", "./packages/backend/dist/index.js"]