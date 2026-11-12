# qwik-like

An invented bike-repair shop that looks like a Qwik City site from the outside (a `q:container`
element, a `<script type="qwik/json">` state, `<route>/q-data.json`, a `?qaction=` form), for the
Qwik and SolidStart checks (FW-07). Nothing here is a real business or deployment. The structure is
the one the @builder.io/qwik and @builder.io/qwik-city 1.20.4 sources write, not copied from any site.

- `/api/preview` sets `preview_session` with no secret: `qwik-solid-draft-public` (a probing check:
  the folder holds a `gaugeline.consent.json`). `/api/draft` asks for a token (401) and passes.
- The canonical points at `spokeandchain-git-main-team.vercel.app`: `qwik-solid-preview-canonical`.
- The embedded state and `/q-data.json` hold `apiToken`: `qwik-solid-private-fields`.
- The sitemap lists `/repairs/q-data.json`: `qwik-solid-data-as-page`.
- `/` answers JSON to `Accept: application/json` with no `Vary`: `qwik-solid-vary-missing`.
- The booking form posts to `/?qaction=...`: `qwik-solid-server-endpoints`.
