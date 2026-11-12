# Gaugeline in a container: the published CLI, run as an unprivileged user, nothing else.
#
#   docker build --build-arg GAUGELINE_VERSION=<x.y.z> -t ghcr.io/alvinwquach/gaugeline:<x.y.z> .
#   docker run --rm --read-only --tmpfs /tmp ghcr.io/alvinwquach/gaugeline:<x.y.z> https://your-preview.example --format sarif --ci
#
# The base image is pinned by digest (node:22-slim, a multi-architecture index). Gaugeline needs
# Node 22 or later (packages/cli/package.json "engines"), so this is not Node 20. Refresh the digest
# with a pull request, never in a build: docker buildx imagetools inspect node:22-slim
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# The version is required and exact, so an image is always one known release: never "latest",
# never a range, a URL or another package name (npm would install any of them). The check is the
# first RUN on its own; scripts/__tests__/docker-image.test.ts runs it with each kind of value.
ARG GAUGELINE_VERSION
ARG VCS_REF=unknown
RUN case "$GAUGELINE_VERSION" in \
      ""|*[!0-9A-Za-z.-]*) ok=no ;; \
      *) printf '%s' "$GAUGELINE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' && ok=yes || ok=no ;; \
    esac; \
    [ "$ok" = yes ] || { echo "Pass --build-arg GAUGELINE_VERSION=<x.y.z>, an exact release (not a tag, a range, a URL or another package)." >&2; exit 1; }
RUN npm install --global --omit=dev --ignore-scripts --no-audit --no-fund "gaugeline@${GAUGELINE_VERSION}" \
 && npm cache clean --force

# Where the image lives: the GitHub Container Registry, under this repository (ghcr.io links a
# package to its repository by the source label). Version and revision come from build arguments.
LABEL org.opencontainers.image.source="https://github.com/alvinwquach/gaugeline" \
      org.opencontainers.image.title="Gaugeline" \
      org.opencontainers.image.description="Checks a live site or a preview deployment. Read only." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${GAUGELINE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/gaugeline-entrypoint

# No secrets are baked in: keys come from the environment at run time (docker run -e NAME) and
# never reach a log, a finding or a report. A site's address is the only thing the CLI is given.
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NO_UPDATE_NOTIFIER=1

# /work is where a mounted folder goes (a config, a baseline). The container needs to write
# nowhere else: with --read-only and --tmpfs /tmp a check runs, and a machine format on stdout
# (--format sarif, junit or json) writes no report file. Without --read-only, /work is the
# node user's, so a plain run can write its report file there.
WORKDIR /work
RUN chown node:node /work
USER node

ENTRYPOINT ["gaugeline-entrypoint"]
CMD ["--help"]
