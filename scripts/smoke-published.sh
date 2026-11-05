#!/usr/bin/env bash
# Smoke-test a published gaugeline version the way a stranger would run it:
#   scripts/smoke-published.sh 0.0.2
#
# By default it runs inside a clean node:18.17-slim container (no git, no pnpm) with
#   docker run --rm --network host node:18.17-slim npx --yes --package=gaugeline@<version> gaugeline ...
#
# Environment:
#   SMOKE_WRONG_URL        a page you own whose canonical points elsewhere (required)
#   SMOKE_CLEAN_URL        a page you own with a correct canonical (required)
#   SMOKE_UNREACHABLE_URL  defaults to http://gaugeline-smoke.invalid/
#   SMOKE_RUNNER           docker (default) or local
#   SMOKE_PACKAGE          install this instead of gaugeline@<version> (a tarball path; skips the registry wait)
#   SMOKE_EXTRA_ARGS       extra flags for every run (for example --allow-private against 127.0.0.1)
#   SMOKE_RETRIES          registry checks before giving up (default 5)
#   SMOKE_RETRY_SECONDS    seconds between them (default 15)
set -uo pipefail

version="${1:?usage: smoke-published.sh <version>}"
package="${SMOKE_PACKAGE:-gaugeline@${version}}"
runner="${SMOKE_RUNNER:-docker}"
retries="${SMOKE_RETRIES:-5}"
wait_seconds="${SMOKE_RETRY_SECONDS:-15}"
unreachable="${SMOKE_UNREACHABLE_URL:-http://gaugeline-smoke.invalid/}"
read -r -a extra <<< "${SMOKE_EXTRA_ARGS:-}"

fail() { echo "smoke: $*" >&2; exit 1; }
[[ -n "${SMOKE_WRONG_URL:-}" ]] || fail "set SMOKE_WRONG_URL to a page with a wrong canonical"
[[ -n "${SMOKE_CLEAN_URL:-}" ]] || fail "set SMOKE_CLEAN_URL to a page with a correct canonical"

# The registry can lag behind a publish by a minute or so.
if [[ -z "${SMOKE_PACKAGE:-}" ]]; then
  found=""
  for ((i = 1; i <= retries; i++)); do
    if npm view "gaugeline@${version}" version >/dev/null 2>&1; then found=1; break; fi
    echo "smoke: gaugeline@${version} is not on the registry yet (try ${i} of ${retries})" >&2
    [[ $i -lt $retries ]] && sleep "${wait_seconds}"
  done
  [[ -n "$found" ]] || fail "gaugeline@${version} never appeared on the registry after ${retries} tries"
fi

run() {
  if [[ "$runner" == "docker" ]]; then
    docker run --rm --network host -e CI= node:18.17-slim \
      npx --yes "--package=${package}" gaugeline "$@" "${extra[@]}"
  else
    CI= npx --yes "--package=${package}" gaugeline "$@" "${extra[@]}"
  fi
}

json_field() { node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String($1))"; }

out=$(run "$SMOKE_WRONG_URL" --json --quiet); code=$?
[[ $code -eq 0 ]] || fail "wrong-canonical page: expected exit 0, got $code"
first=$(printf '%s' "$out" | json_field 'r.findings.length + " " + (r.findings[0] ? r.findings[0].checkId : "")') \
  || fail "wrong-canonical page: stdout is not JSON"
[[ "$first" == "1 canonical-elsewhere" ]] || fail "wrong-canonical page: expected one canonical-elsewhere finding, got: $first"

run "$SMOKE_WRONG_URL" --ci --quiet >/dev/null; code=$?
[[ $code -eq 1 ]] || fail "wrong-canonical page with --ci: expected exit 1, got $code"

out=$(run "$SMOKE_CLEAN_URL" --json --quiet); code=$?
[[ $code -eq 0 ]] || fail "clean page: expected exit 0, got $code"
clean=$(printf '%s' "$out" | json_field 'r.findings.length + " " + r.passed.includes("canonical-elsewhere")') \
  || fail "clean page: stdout is not JSON"
[[ "$clean" == "0 true" ]] || fail "clean page: expected no findings and canonical-elsewhere passed, got: $clean"

errfile=$(mktemp)
out=$(run "$unreachable" --quiet 2>"$errfile"); code=$?
err=$(cat "$errfile"); rm -f "$errfile"
[[ $code -eq 2 ]] || fail "unreachable host: expected exit 2, got $code"
[[ -z "$out" ]] || fail "unreachable host: expected empty stdout, got: $out"
[[ -n "$(printf '%s' "$err" | head -1)" ]] || fail "unreachable host: expected a reason on stderr"

echo "smoke: ${package} passed (wrong canonical, --ci, clean, unreachable)"
