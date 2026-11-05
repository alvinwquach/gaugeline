# images

An invented haberdashery for the G10a image checks: 40 same-site images and one on another host.
Every image route answers with headers only (an empty body), so nothing is a real picture.

- `/img/missing.png` is a 404.
- `/img/heavy.jpg` declares a Content-Length of 900,000 bytes; `/img/divider.png` sends no Content-Length.
- `/img/garden.jpg` is the JPEG fallback in a `<picture>` with an AVIF source; `/img/logo.svg` is an SVG.
- `/_next/image?url=%2Fhero.jpg&w=3840` asks Next.js for a 3840-pixel-wide image.
- `/wp-content/uploads/2019/05/old-sign.jpg` is left over from an old WordPress site.
- `swatch-0` and `swatch-1` have no alt attribute; `divider.png` has a decorative `alt=""`.
- `https://cdn.other.example/` is another host and is never requested.
- Only the first 20 same-site images are requested.
