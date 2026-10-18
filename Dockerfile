# syntax=docker/dockerfile:1
# One image for every service; the entrypoint picks the bundle (dist/<service>.js).
FROM node:26-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/ingest/package.json services/ingest/
COPY services/router/package.json services/router/
COPY services/mock-buyer/package.json services/mock-buyer/
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts scripts
COPY packages packages
COPY services services
RUN npm run build

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/dist dist
COPY db/migrations db/migrations
USER node
ENTRYPOINT ["node", "--enable-source-maps"]
CMD ["dist/ingest.js"]
