# angular-like

An invented physiotherapy clinic that looks like an Angular SSR (Analog) site from the outside, for the
Angular checks (FW-06). Nothing here is a real business or deployment. The markup reproduces the
structure the renderer writes (a root element with `ng-version`, `ng-server-context` and `ngh`
attributes, an `ng-state` JSON script holding state and an HttpClient transfer-cache entry), with
invented content.

- A `/@vite/client` script, as left by a dev server: `angular-dev-tools-public`.
- The canonical points at `harbourside-physio-git-main.vercel.app`: `angular-preview-canonical`.
- The transfer state carries `adminToken`, `internalNotes` and `wholesaleRate`:
  `angular-state-private-fields`. The values are invented.
- The page shows an Angular error (NG0201 and a stack frame) with HTTP 200: `angular-ssr-error-200`.
  A real page would rarely carry this and the dev client together; the fixture does so to exercise
  every check in one run.
- The page names the `c3b1e9a2` server function and the `exercises` page endpoint:
  `angular-analog-endpoints-listed`. None of those addresses is ever requested.
