# astro-like

An invented yoga studio blog that looks like an Astro site from the outside, for the Astro checks
(FW-02). Nothing here is a real business or deployment. The markup reproduces the structure Astro
writes (an `astro-island` element with serialised props, `data-astro-cid-*` attributes, scripts under
`/_astro/`, a server-island script, a `?_action=` form), with invented content.

- A `/@vite/client` script and a `data-astro-source-file` attribute, as left by `astro dev`:
  `astro-dev-tools-public`.
- The canonical points at `fernlight-yoga-git-main.vercel.app`: `astro-preview-canonical`.
- The booking island's props carry `apiToken` and `internalNotes`: `astro-private-props`.
- The newsletter island's props carry `draft: true`: `astro-draft-entry-public`.
- The page calls the `bookClass` and `subscribe` actions and loads the `NextClass` server island:
  `astro-endpoints-listed`. None of those addresses is ever requested.
