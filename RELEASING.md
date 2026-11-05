# Releasing

`gaugeline` (`packages/cli`) is the published package. The engine (`@gaugeline/core`) is bundled
into it, so `npx gaugeline` downloads one tarball with no dependencies. Versions come from
Changesets; nobody hand-writes the changelog.

## What CI proves on every pull request

- Tests on Node 18.17, 20 and 22 on Linux, and Node 20 on macOS and Windows.
- `pnpm smoke` packs the CLI exactly as npm would and fails when the tarball holds anything but
  `dist/`, `README.md`, `LICENSE` and `package.json`, is over 1 MB, or does not run with
  `npx --package=<tarball> gaugeline` under Node 18.17.
- `pnpm docs:changelog --check`: the docs changelog matches `CHANGELOG.md` and the backfill file.

## The Release pull request (switched off until the owner opts in)

`.github/workflows/release-pr.yml` runs on every push to `main`, but only when the repository
variable `RELEASE_PR_ENABLED` is `true`. It then opens or updates one pull request titled "Release"
that deletes the `.changeset` files, bumps versions (`gaugeline` and, once it exists,
`gaugeline-free` share one version), rewrites `CHANGELOG.md` and regenerates the docs changelog.

Merging the Release pull request publishes **only** if `PUBLISH_ENABLED` is also `true` and the
`NPM_TOKEN` secret exists: `changeset publish` runs with provenance, pushes the `v<version>` tag,
and the smoke job installs the published version by name in a clean `node:18.17-slim` container
(`scripts/smoke-published.sh`, using the `SMOKE_WRONG_URL` and `SMOKE_CLEAN_URL` variables). The wrong-canonical page must give a `canonical-elsewhere` finding; the clean page must pass `canonical-elsewhere` and have no "Fix this first" finding. Other findings on either page are fine.

Pushes to `main` only come from merged pull requests, so a fork can never reach the token.

## Publishing by hand

```bash
pnpm build
pnpm smoke
cd packages/cli && npm publish --provenance --access public
bash scripts/smoke-published.sh "$(node -p "require('./packages/cli/package.json').version")"
```

`scripts/check-tag-version.ts <tag>` refuses a tag that does not match `packages/cli/package.json`.
