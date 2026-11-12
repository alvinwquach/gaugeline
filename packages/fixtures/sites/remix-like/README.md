# remix-like

An invented ceramics shop that looks like a React Router 7 (Remix) site from the outside: the
inline `window.__reactRouterContext` script, its streamed `streamController.enqueue(...)` chunk of
loader data in turbo-stream form, and a sitemap that lists a `.data` address. For the Remix pack
(FW-04). Nothing here is a real business or deployment. The structure is the one react-router
7.18.5 writes (`lib/dom/ssr/components.tsx`, `lib/server-runtime/server.ts`), not copied from a site.

- `/preview` sets `preview_session` with no secret: `remix-draft-public` (a probing check: the
  folder holds a `gaugeline.consent.json`). `/draft` asks for a token (401) and passes.
- The canonical points at `marrowlane-git-main-studio.vercel.app`: `remix-preview-canonical`.
- The streamed loader data holds `wholesaleToken`: `remix-private-fields`.
- The sitemap lists `/shop.data`, which answers `text/x-script`: `remix-data-as-page`.
