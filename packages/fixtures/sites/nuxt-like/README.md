# nuxt-like

An invented neighbourhood bakery that looks like a Nuxt site from the outside (`/_nuxt/` scripts, a
`__NUXT_DATA__` payload and a `window.__NUXT__` config), for the Nuxt checks (FW-01). Nothing here is
a real business or deployment. The markup follows the shapes Nuxt's own renderer writes (read from
its published source), with invented content.

- The canonical points at `marrow-rye-git-main.vercel.app`:
  `nuxt-preview-canonical`.
- The sitemap lists two `_payload.json` addresses: `nuxt-framework-file-listed`.
- The payload has `stripeSecretKey` and `supabaseServiceRole` with values (and an empty
  `mailerPassword`), and the public config has `mailgunApiKey`: `nuxt-private-state`.
- The page loads `/_nuxt/@vite/client`: `nuxt-dev-build-live`.
- The page is sent with `cache-control: public, max-age=31536000, immutable`:
  `nuxt-page-cache-header`.
- Asked with `?preview=true` the page answers with `_preview-state` enabled: `nuxt-preview-public`
  (probing, needs consent).
- `/__nuxt_devtools__/client/` answers with a page titled Nuxt DevTools: `nuxt-devtools-public`
  (probing, needs consent).
