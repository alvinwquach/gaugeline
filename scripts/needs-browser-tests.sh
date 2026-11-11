#!/usr/bin/env bash
# Decides whether the docs workflow runs the Playwright tests. Prints run=true or run=false to
# $GITHUB_OUTPUT (and to stdout). Always true on a push to main; on a pull request, true only when the
# change touches the docs, the check registry, the docs build or what the browser tests drive.
# Needs the base branch's history (the workflow checks out with fetch-depth 0).
set -euo pipefail

emit() {
  echo "run=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "run=$1" >> "$GITHUB_OUTPUT"; fi
}

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  emit true
  exit 0
fi

base="origin/${BASE_REF:-main}"
git fetch --quiet origin "${BASE_REF:-main}"
changed=$(git diff --name-only "$base"...HEAD)

# One pattern per line. A match on any changed file turns the browser tests on.
patterns='^docs/
^e2e/
^playwright\.config\.ts$
^vitest\.docs\.config\.ts$
^packages/core/src/checks/
^packages/app/
^packages/app-server/
^scripts/(build-docs|check-docs|gen-checks|changelog-to-docs|build-demo|docs-examples)\.ts$
^scripts/lib/
^package\.json$
^pnpm-lock\.yaml$
^\.github/workflows/docs\.yml$
^scripts/needs-browser-tests\.sh$'

if printf '%s\n' "$changed" | grep -Eq -f <(printf '%s\n' "$patterns"); then
  emit true
else
  echo "No change to the docs, the check registry, the docs build or the app: skipping the browser tests."
  emit false
fi
