# Releasing

`gaugeline` (the `packages/cli` package) is the only package published to npm. The engine
(`@gaugeline/core`) is bundled into it, so `npx gaugeline` downloads one tarball with no
dependencies.

## What CI proves on every pull request

- Tests on Node 18.17, 20 and 22 on Linux, and Node 20 on macOS and Windows.
- `pnpm smoke` packs the CLI exactly as npm would and fails when:
  - the tarball holds anything but `dist/`, `README.md`, `LICENSE` and `package.json`;
  - the tarball is over 1 MB;
  - `npx --package=<tarball> gaugeline <fixture>` does not run cleanly under Node 18.17.

## Publishing (done by the owner)

Nothing publishes automatically. The release workflow (`.github/workflows/release.yml`) only runs
when started by hand from the Actions tab on `main`, and it is a dry run unless the "publish" box is
ticked. Pull requests, including ones from forks, cannot start it, so they can never reach the token.

1. Add an npm automation token as the repository secret `NPM_TOKEN`.
2. Set `"private": false` in `packages/cli/package.json` (K01 prepares this).
3. Run the Release workflow with "publish" ticked. It builds, tests, runs the smoke check and then
   `npm publish --provenance --access public`, so the npm page shows that the tarball was built from
   this repository by GitHub Actions.

To check locally what would be published:

```bash
pnpm build
pnpm smoke
```
