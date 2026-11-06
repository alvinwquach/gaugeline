# next-like

An invented letterpress studio that looks like a Next.js site from the outside (a
`/_next/static/` script), for the Next.js checks (X38). Nothing here is a real business or
deployment.

- 40 links to `/_next/data/...json` payloads: discovery ignores and counts them, never requests them.
- `/api/draft` sets `__prerender_bypass` with no secret: `next-draft-public`. `/api/preview` asks
  for a token (401) and passes.
- The canonical points at `larkspur-git-main-studio.vercel.app`: `next-preview-canonical`.
