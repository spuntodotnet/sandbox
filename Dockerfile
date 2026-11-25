# sandbox.spunto.net: the docs site (docs/, a static export) and install.sh, served by nginx on 8080.
# Built and pushed by .github/workflows/deploy.yml; run by the ops stack of test-2 (coderhammer/work).
FROM node:24-alpine AS build
WORKDIR /src/docs
COPY docs/package.json docs/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docs/ ./
RUN npm run build

FROM nginx:1.29-alpine
COPY docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/docs/out /usr/share/nginx/html
COPY install.sh /usr/share/nginx/html/install.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
