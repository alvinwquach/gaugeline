# sveltekit-like

An invented climbing gym that looks like a SvelteKit site from the outside (an inline
`__sveltekit_<hash>` bootstrap script with `node_ids` and `data`, `/_app/immutable/entry/` modules,
`/_app/version.json`, `<page>/__data.json`), for the SvelteKit checks (FW-03). Nothing here is a
real business or deployment. The structure is the one SvelteKit's own source writes
(`runtime/server/page/render.js`, `data/index.js`), not copied from any site.

- `/api/preview` sets `preview_session` with no secret: `sveltekit-draft-public` (a probing check:
  the folder holds a `gaugeline.consent.json`). `/api/draft` asks for a token (401) and passes.
- The canonical points at `cragnorth-git-main-team.vercel.app`: `sveltekit-preview-canonical`.
- The embedded state and `/__data.json` hold `apiToken`: `sveltekit-private-fields`; `coachNotes` is
  not on the page: `sveltekit-data-unshown`.
- The page says version `1731000000000`, `/_app/version.json` says `1731099999999`:
  `sveltekit-stale-page`.
- The sitemap lists `/classes/__data.json`: `sveltekit-data-as-page`.
- `/` answers JSON to `Accept: application/json` with no `Vary`: `sveltekit-vary-missing`.
