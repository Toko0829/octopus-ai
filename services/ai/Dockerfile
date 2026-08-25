# services/ai — the reasoning core, as a CPU-only container.
#
# Owner doc: docs/30-modules/infra-devops.md (deployment topology)
#
# Build from `services/ai` as the context, not the repo root:
#   docker build -t octopus-ai services/ai
# The service is outside the pnpm workspace (ADR-0006) and needs nothing from it,
# and a repo-root context would ship node_modules and .git to the daemon.
#
# Two jobs, and it is deliberately one image for both. CI's five eval shards each
# pay ~90s of setup installing torch and restoring ~4.6GB of cached weights, and
# `ci.yml` names that floor as the reason splitting past five shards stops
# helping. Fly.io is the pinned deployment target for this service. Both want the
# same thing: torch and both models already present before the process starts.
#
# **The weights are baked, not fetched.** An image that downloads on boot has a
# cold start measured in minutes and needs the network healthy at exactly the
# wrong moment. It also contradicts how this service already treats a missing
# model: `main.py` warms the embedder during startup so a corrupt or absent one
# fails there, with a named error, rather than on somebody's first question.
#
# **Layer order is deliberate.** Dependencies, then weights, then source. Source
# changes on every commit and must not invalidate the ~5GB above it; the weights
# layer is invalidated only by the model ids in the ARGs below.
#
# CPU-only torch comes from `uv.lock`, not from anything here. Pinning it in the
# image alone would mean CI scored the golden set on one torch build while this
# ran another, and ADR-0009 records that such a bump moves model scores.

ARG EMBED_MODEL=BAAI/bge-m3
ARG RERANK_MODEL=BAAI/bge-reranker-v2-m3

# ---------------------------------------------------------------- dependencies

FROM python:3.12-slim-bookworm AS deps

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

# Compile bytecode at install time rather than on first import. Copy rather than
# symlink out of the uv cache, because the venv is copied into a later stage and
# a symlink into a cache that no longer exists is a broken venv.
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_PYTHON_DOWNLOADS=never

WORKDIR /app/services/ai

# Manifests only, so `uv sync` re-runs when the lockfile moves and not when a
# source file does. `--no-install-project` because the project itself is source,
# and installing it here would put it in the layer we are keeping stable.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra local-embed --no-install-project

# ---------------------------------------------------------------- model weights

FROM deps AS weights

ARG EMBED_MODEL
ARG RERANK_MODEL
ENV HF_HOME=/opt/hf

# `onnx/*` is excluded because both repos ship a complete ONNX duplicate of the
# weights that nothing here loads: roughly half the download for no benefit.
#
# That exclusion is also why the runtime points at a PATH rather than a repo id.
# FlagEmbedding re-resolves a repo id through `snapshot_download` WITHOUT these
# exclusions, so under HF_HUB_OFFLINE the hub client judges the cache incomplete
# and refuses to load over files the model never needed (see local_embedder.py).
# A directory skips that check entirely.
#
# The resolved snapshot directory carries a commit hash, so it is symlinked to a
# STABLE path. That is not cosmetic, and it was found by running the image rather
# than by reading it. The alternative, sourcing resolved paths in a shell CMD,
# puts them only in that shell: anything overriding CMD sees nothing, and
# `docker run <image> python -m octopus_ai.evaluation --shard ...` is exactly how
# CI's eval shards invoke this. It failed on an empty path with a repo-id error.
RUN /app/services/ai/.venv/bin/python -c "\
import os; \
from huggingface_hub import snapshot_download; \
ignore = ['onnx/*', '*.onnx']; \
print('embed:', snapshot_download(os.environ['EMBED_MODEL'], ignore_patterns=ignore)); \
print('rerank:', snapshot_download(os.environ['RERANK_MODEL'], ignore_patterns=ignore))" \
 && mkdir -p /opt/models \
 && ln -s "$(ls -d /opt/hf/hub/models--BAAI--bge-m3/snapshots/*)" /opt/models/embed \
 && ln -s "$(ls -d /opt/hf/hub/models--BAAI--bge-reranker-v2-m3/snapshots/*)" /opt/models/rerank \
 && ls -l /opt/models

# ---------------------------------------------------------------- runtime

FROM python:3.12-slim-bookworm AS runtime

ARG EMBED_MODEL
ARG RERANK_MODEL

# Not root. The service opens no files it did not ship with and writes nothing to
# disk, so there is no reason for it to be able to.
RUN useradd --create-home --uid 10001 octopus

COPY --from=weights --chown=octopus:octopus /app/services/ai/.venv /app/services/ai/.venv
COPY --from=weights --chown=octopus:octopus /opt/hf /opt/hf
COPY --from=weights --chown=octopus:octopus /opt/models /opt/models

# Source last: it is what changes on every commit.
#
# The path is NOT arbitrary. `config.py` resolves `_REPO_ROOT` as `parents[4]` of
# its own file to find local `.env` files, so the package must sit four levels
# below a directory that exists. Flattening this to /app makes that an IndexError
# at import time. Mirroring the repo layout costs nothing and keeps a container
# and a developer checkout resolving the same way; the .env files simply are not
# here, which `load_local_env` already tolerates.
COPY --chown=octopus:octopus src /app/services/ai/src
COPY --chown=octopus:octopus corpus /app/services/ai/corpus
COPY --chown=octopus:octopus eval /app/services/ai/eval

ENV PATH="/app/services/ai/.venv/bin:${PATH}"
ENV PYTHONPATH=/app/services/ai/src
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/opt/hf

# Nothing is fetched at run time. Every weight the process needs is in the layer
# above, so a silent network reach for a model is a bug, and this makes it fail
# loudly rather than succeed slowly.
ENV HF_HUB_OFFLINE=1

# Model IDENTITY. Stamped on `doc_chunks.embed_model` and folded into the
# ingestion hash, so it must be stable across hosts. Kept apart from LOCATION
# below on purpose: collapsing them writes a container-specific path into every
# row's provenance and makes an identical model on a different layout look like a
# change worth re-embedding (ADR-0008).
ENV EMBED_PROVIDER=local
ENV EMBED_LOCAL_MODEL=${EMBED_MODEL}
ENV RERANK_PROVIDER=local
ENV RERANK_LOCAL_MODEL=${RERANK_MODEL}

# Model LOCATION. A stable symlink rather than the hash-bearing snapshot path, so
# these can be plain ENV that every process in the container inherits, including
# one that overrides CMD. A directory rather than a repo id is required and not
# merely preferred: under HF_HUB_OFFLINE, FlagEmbedding re-resolves a repo id
# without our ONNX exclusions and refuses to load over files it never needed.
ENV EMBED_LOCAL_PATH=/opt/models/embed
ENV RERANK_LOCAL_PATH=/opt/models/rerank

USER octopus
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health').read()"

# `start-period` is three minutes because startup warms the embedder before the
# service is ready, by design: paying a multi-second model load inside the first
# request once made a cold service indistinguishable from a dead one (ADR-0008).
# An orchestrator that kills it at 30s would recreate exactly that symptom.
#
# One worker, deliberately. Each holds its own copy of both models in fp32 (fp16
# is meaningless on CPU, see config.py), so a second worker doubles memory to buy
# concurrency on a service whose bottleneck is per-request CPU. Scale with
# instances, not with workers.
#
# Exec form with no shell wrapper, so `docker run <image> <another command>`
# reaches the eval harness with the model paths already in its environment.
CMD ["uvicorn", "octopus_ai.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
