# noindex-header-missing

An invented pop-up cafe (Dockside Coffee), hidden from search until opening day, for `noindex-header-missing`
(FF-03). Nothing here is a real business.

- `/`: says noindex in its metadata.
- `/studio` (`routes.json`): the editor studio answers 200 with no `X-Robots-Tag`: the finding.
- `/api/health`: an API route that sends `X-Robots-Tag: noindex`: fine.
- `/gaugeline-not-found-3f9c2a71`: the made-up address answers 404.
- `gaugeline.hidden.json` hides the whole site and lists the two routes to ask; `gaugeline.consent.json` is the
  invented owner's consent to the probing check.
