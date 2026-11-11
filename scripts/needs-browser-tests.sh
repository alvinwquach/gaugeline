#!/usr/bin/env bash
# Decides whether the docs workflow runs the Playwright tests. Prints run=true or run=false to
# $GITHUB_OUTPUT (and to stdout). Always true on a push to main; on a pull request or a merge queue run, true only when the
# change touches the docs, the check registry, the docs build or what the browser tests drive.
# Needs the base branch's history (the workflow checks out with fetch-depth 0).
set -euo pipefail

emit() {
  echo "run=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "run=$1" >> "$GITHUB_OUTPUT"; fi
}

# A push to main always runs them. A pull request is compared with its base branch; a merge queue run with the
# commit the queue built on (BASE_SHA), so the queue runs them only when the queued change needs them.
case "${EVENT_NAME:-}" in
  pull_request)
    base="origin/${BASE_REF:-main}"
    git fetch --quiet origin "${BASE_REF:-main}"
    ;;
  merge_group)
    base="${BASE_SHA:-}"
    if [ -z "$base" ]; then emit true; exit 0; fi
    ;;
  *)
    emit true
    exit 0
    ;;
esac
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
