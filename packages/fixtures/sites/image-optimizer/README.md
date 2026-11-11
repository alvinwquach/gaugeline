# image-optimizer

An invented neighbourhood bakery (Cedar and Crumb Bakery) for the image optimizer checks (XF-04). Nothing
here is a real business.

- `/` uses the Next.js image address `/_next/image` twice. `next.config.js` is the site's settings file with
  `hostname: "**"`: the finding of `image-optimizer-allowlist-wide`, which reads the file and sends nothing.
- `netlify.toml` is a second settings file whose `remote_images` expression is not anchored: the finding of
  `image-optimizer-allowlist-unanchored`.
- `/_next/image` (`routes.json`) answers 200 with image bytes for any address, as an open optimizer does:
  the finding of `image-optimizer-open`, a probing check, so `gaugeline.consent.json` gives the invented
  owner's consent to runs started from this folder. `gaugeline.images.json` names the settings file and the
  one outside picture the owner chose.
