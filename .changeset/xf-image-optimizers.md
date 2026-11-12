---
"gaugeline": minor
---

Three new checks for every framework: image-optimizer-allowlist-wide and image-optimizer-allowlist-unanchored read your image settings (next.config, nuxt.config, astro.config, netlify.toml, named in gaugeline.images.json) and find an allowlist that lets any host through, and image-optimizer-open (a probing check, only with --owner-consent and an address you chose) finds an image address that fetches a picture from a website you did not list.
