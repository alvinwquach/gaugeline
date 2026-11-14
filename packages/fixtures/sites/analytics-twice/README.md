# analytics-twice

An invented yoga studio (Tidewater Yoga) for `analytics-loaded-twice` (NAV-07). Nothing here is a real business.

- The Tag Manager snippet for container `GTM-TW1D3R4` is pasted twice, once in the head and once at the end of the body (with its noscript iframe once): two installs.
- `gtag.js` is loaded once for `G-TIDE000001` but `gtag('config', ...)` is called twice: the id is configured twice.
- The invented ids are not real containers or properties. The check reads the page only: a run with `--trackers` would also ask for the container's public file, which an offline test never reaches.
