# Container image for the Lovable -> Dokploy deployer WEB APP itself.
# (Not to be confused with Dockerfile.static / Dockerfile.ssr, which are templates
#  this tool copies into Lovable repos.)
#
# The web app shells out to `git` to clone/push, so git is installed here.
# It binds 0.0.0.0 inside the container so Dokploy/Traefik can reach it.
FROM node:22-alpine AS runtime
RUN apk add --no-cache git ca-certificates
WORKDIR /app

# Repo root holds the kit templates the app reads at runtime (vite.deploy.config.ts,
# Dockerfile.static, Dockerfile.ssr, nginx.conf, .dockerignore) plus webapp/.
COPY . .

WORKDIR /app/webapp
ENV HOST=0.0.0.0
ENV PORT=4317
EXPOSE 4317
CMD ["node", "server.js"]
