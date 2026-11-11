# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim AS dependencies
WORKDIR /app
COPY --link package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci

FROM dependencies AS build
COPY --link tsconfig.json tsconfig.build.json eslint.config.mjs ./
COPY --link src ./src
RUN npm run build

FROM build AS tools
COPY --link --chown=1000:1000 scripts ./scripts
COPY --link --chown=1000:1000 test ./test
COPY --link --chown=1000:1000 local ./local
COPY --link --chown=1000:1000 docker ./docker
RUN mkdir -p /app/.local /app/docs && chown -R node:node /app/.local /app/docs
ENV BACKOFFICE_RUNTIME=docker NODE_ENV=development
USER node
ENTRYPOINT ["sh", "/app/docker/app-entrypoint.sh"]
CMD ["npm", "run", "typecheck"]

FROM node:26.13.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY --link package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --omit=dev

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Delivery Backoffice backend" \
      org.opencontainers.image.source="local/delivery-backoffice/backoffice-backend"
COPY --link --from=production-dependencies /app/node_modules ./node_modules
COPY --link --from=build /app/dist ./dist
COPY --link docker/app-entrypoint.sh ./docker/app-entrypoint.sh
RUN mkdir -p /app/.local && chown node:node /app/.local
ENV BACKOFFICE_RUNTIME=docker NODE_ENV=production
EXPOSE 3001
USER node
ENTRYPOINT ["sh", "/app/docker/app-entrypoint.sh"]
CMD ["node", "dist/main.js"]
