# apps/web — the Next.js frontend and thin BFF, as a container.
#
# Owner doc: docs/30-modules/design-system-frontend.md
#
# Build from the REPO ROOT, not from this directory:
#   docker build -f apps/web/Dockerfile -t octopus-web .
# Same reason as apps/api: `workspace:*` dependencies resolve through the root
# lockfile, so a narrower context cannot install them.
#
# **This image is built with the Supabase public values present, and the build
# fails without them in a way worth understanding.** `NEXT_PUBLIC_*` variables are
# inlined into the browser bundle at BUILD time, not read at run time, so an image
# built without them produces a page whose client cannot reach Supabase however
# the container is later configured. That is the opposite of what CI wants, and
# CI is right for its purpose: `design-system-frontend.md` records that CI builds
# with no Supabase env deliberately, to prove the build depends on no runtime
# config. Both are true because they are testing different things. CI asks
# whether the build stands up; this asks whether the page works.
#
# The values come from `apps/web/.env.local`, which Next loads by itself, so
# there is no build-arg plumbing and no second copy of them to drift. That file
# is documented in its own header as public values only, and the browser receives
# everything in it regardless of what this image does, which is why copying it
# here is safe and why putting an `sb_secret_` key in it never would be.

FROM node:22-bookworm-slim

RUN corepack enable

WORKDIR /app

# `tsconfig.base.json` is copied with the manifests, not with the source, because
# both apps' tsconfigs extend it: without it `next build` fails at TS5083 and tsx
# resolves paths against a config that is not there.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
# The fake provider's consent screen imports `@octopus/marketing/fake-consent-code`,
# because the authorization-code format has to agree with the server that decodes
# it and two copies of an encoding are two copies that can disagree.
COPY packages/marketing/package.json packages/marketing/
# The node console reads the skill taxonomy and the eligibility sentences from
# here, so the same sentence a route refuses with is the one the page prints.
# Added late: slice 4 declared the dependency and left this list alone, which is
# exactly the omission the assertion below exists to catch.
COPY packages/marketplace/package.json packages/marketplace/

RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# The same assertion `apps/api/Dockerfile` carries, now that this image has more
# than two workspace dependencies to forget one of.
#
# Its commit message said "apps/web needs no equivalent today, declaring only
# @octopus/config and @octopus/contracts. If it grows a third, the guard belongs
# there too." It grew a third in the next slice. A missing COPY above does not
# fail the install: pnpm links a workspace dependency by path, a symlink to a
# directory that does not exist yet is legal, and `COPY packages/` below then
# creates it, so the image builds green and the failure arrives at runtime naming
# a third-party module that is not the problem.
RUN node -e "const fs=require('fs'),pkg=require('/app/apps/web/package.json'),deps=Object.entries({...pkg.dependencies,...pkg.devDependencies}).filter(([,v])=>String(v).startsWith('workspace:')).map(([k])=>k),missing=deps.filter(d=>!fs.existsSync('/app/apps/web/node_modules/'+d+'/package.json'));if(missing.length){console.error('\n  Not installed: '+missing.join(', ')+'\n  Add a COPY line for each above the install step in this Dockerfile.\n');process.exit(1)}console.log('workspace deps installed: '+deps.join(', '))"

COPY packages/ packages/
COPY apps/web/ apps/web/

# `next build` reads apps/web/.env.local from the copy above. NODE_ENV is left at
# its default until after the build, because Next sets its own during a build and
# forcing it earlier changes which dependencies are considered available.
RUN pnpm --filter @octopus/web build

ENV NODE_ENV=production

# API_URL is deliberately NOT baked. It is read server-side by the BFF, and its
# value differs between a developer's machine and this network, where the API is
# a service name rather than localhost. Compose sets it. Next's env loader does
# not overwrite a variable that is already in the environment, so the value in
# .env.local loses to the one compose supplies, which is the behaviour wanted
# here rather than a coincidence to rely on quietly.
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@octopus/web", "start"]
