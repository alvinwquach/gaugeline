#!/usr/bin/env bash
# Deploy the built docs site. The host lives in this one file, so changing host is one diff.
#   scripts/deploy-docs.sh preview <pull-request-number>   prints the preview address
#   scripts/deploy-docs.sh production
# Host: Netlify, through its CLI. Needs NETLIFY_AUTH_TOKEN (secret) and NETLIFY_SITE_ID (variable).
# Nothing calls this unless the repository variable DOCS_DEPLOY_ENABLED is "true".
set -euo pipefail

mode="${1:?usage: deploy-docs.sh preview <pr> | production}"
dir="${DOCS_DIST:-docs/.vitepress/dist}"
[[ -d "$dir" ]] || { echo "deploy-docs: $dir does not exist. Run pnpm docs:build first." >&2; exit 1; }
[[ -n "${NETLIFY_AUTH_TOKEN:-}" && -n "${NETLIFY_SITE_ID:-}" ]] || {
  echo "deploy-docs: NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID are not set; skipping the deploy." >&2
  exit 0
}

case "$mode" in
  preview)
    pr="${2:?usage: deploy-docs.sh preview <pull-request-number>}"
    out=$(npx --yes netlify-cli@17 deploy --dir "$dir" --alias "pr-${pr}" --site "$NETLIFY_SITE_ID" --json)
    node -e "process.stdout.write(JSON.parse(process.argv[1]).deploy_url)" "$out"
    ;;
  production)
    npx --yes netlify-cli@17 deploy --dir "$dir" --prod --site "$NETLIFY_SITE_ID" >/dev/null
    echo "deploy-docs: production deploy done"
    ;;
  *)
    echo "deploy-docs: unknown mode $mode" >&2
    exit 1
    ;;
esac
