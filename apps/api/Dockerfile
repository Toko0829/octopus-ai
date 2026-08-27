# apps/api — the authoritative Fastify API, as a container.
#
# Owner doc: docs/10-architecture/architecture.md
#
# Build from the REPO ROOT, not from this directory:
#   docker build -f apps/api/Dockerfile -t octopus-api .
# The opposite of `services/ai`, which builds from its own directory because
# ADR-0006 keeps it out of the pnpm graph. This app depends on three workspace
# packages through `workspace:*`, and pnpm resolves those through the root
# lockfile, so a context narrower than the root cannot install it.
#
# Normally reached through `docker compose up` at the repo root.

FROM node:22-bookworm-slim

# corepack ships with node and pins pnpm to whatever `packageManager` in the root
# package.json says, so the container and a developer checkout install with the
# same pnpm rather than with whatever was newest on build day.
RUN corepack enable

WORKDIR /app

# Manifests first, so `pnpm install` is re-run when a dependency moves and not
# when a source file does. Every workspace package the API imports has to be
# listed: pnpm reads the whole workspace graph at install time, and a missing
# manifest fails as an unresolvable `workspace:*` rather than as a missing file.
# `tsconfig.base.json` is copied with the manifests, not with the source, because
# both apps' tsconfigs extend it: without it `next build` fails at TS5083 and tsx
# resolves paths against a config that is not there.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/

# Dev dependencies are installed on purpose. `apps/api`'s own start script runs
# through tsx rather than a compiled bundle (see its package.json), so tsx is a
# runtime dependency of this image whatever the manifest calls it. Building to
# JavaScript first would be the leaner image and a different change: the repo
# has no bundling step for services yet, and inventing one here would put the
# container and `pnpm dev` on two different execution paths.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/

# Overridden by compose. Stated here so `docker run` alone produces a service
# that listens somewhere predictable rather than depending on the environment.
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3011

EXPOSE 3011

# The route is public by design (`createRequireAuth` is attached per route so
# `/api/health` stays reachable), which is what makes it usable as a probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3011)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `--filter` rather than a WORKDIR change, so pnpm resolves the workspace from
# the root it was installed at.
CMD ["pnpm", "--filter", "@octopus/api", "start"]
