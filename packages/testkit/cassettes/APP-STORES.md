# App store cassettes

`app-stores.json`, `app-stores-regional.json` and `app-stores-rate-limited.json` were written by
hand, not recorded. The apps, ids, packages and page are invented. The responses follow the
documented shapes: the iTunes Lookup API's JSON (`resultCount`, `results[].trackName`) and a Google
Play listing's `<title>Name - Apps on Google Play</title>`. Recording real store responses would put
real apps in the repository, which the fixture rules forbid.

- `app-stores`: a live App Store app, a UK link to an app that no longer exists anywhere, a Google
  Play app that was renamed, and a Google Play package that answers 404. The Smart App Banner names a
  third App Store id. It also answers robots.txt, the sitemap, llms.txt (404) and the www host
  (a 301), so a full run is clean apart from the app findings.
- `app-stores-regional`: a UK App Store link to an app that is only sold in the US store.
- `app-stores-rate-limited`: Google Play answers 429.
