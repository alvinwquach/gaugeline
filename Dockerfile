# Gaugeline in a container: the published CLI, run as an unprivileged user, nothing else.
#
#   docker build --build-arg GAUGELINE_VERSION=<x.y.z> -t gaugeline .
#   docker run --rm --read-only --tmpfs /tmp gaugeline https://your-preview.example --format sarif --ci
#
# The base image is pinned by digest (node:22-slim, a multi-architecture index). Gaugeline needs
# Node 22 or later (packages/cli/package.json "engines"), so this is not Node 20. Refresh the digest
# with a pull request, never in a build: docker buildx imagetools inspect node:22-slim
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# The version is required, so an image is always one known release and never "whatever is latest".
ARG GAUGELINE_VERSION
RUN test -n "$GAUGELINE_VERSION" || { echo "Pass --build-arg GAUGELINE_VERSION=<x.y.z>" >&2; exit 1; } \
 && npm install --global --omit=dev --ignore-scripts --no-audit --no-fund "gaugeline@${GAUGELINE_VERSION}" \
 && npm cache clean --force

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/gaugeline-entrypoint

# No secrets are baked in: keys come from the environment at run time (docker run -e NAME) and
# never reach a log, a finding or a report. A site's address is the only thing the CLI is given.
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NO_UPDATE_NOTIFIER=1

# /work is where a mounted folder goes (a config, a baseline). The container needs to write
# nowhere else: with --read-only and --tmpfs /tmp a check runs, and a machine format on stdout
# (--format sarif, junit or json) writes no report file.
WORKDIR /work
USER node

ENTRYPOINT ["gaugeline-entrypoint"]
CMD ["--help"]
