# source

Invented project folders for the checks that read a repository (batch FF). Nothing here is a real business.

- `<check-id>/fail/` and `<check-id>/pass/`: the smallest folder that makes the check raise a finding, and the same folder fixed.
- `harbour-bar-preview/`: a bar's pre-launch copy with the three indexing problems at once, used by the docs example for `gaugeline source`.
- `harbour-bar-switch/`: a bar whose indexing switch accepts more than `true` and whose CI tests noindex only on previews, used by the docs example for the two checks that read them.
- `zod-version-advisory/` and `next-version-advisory/`: a lockfile that installs a version inside an advisory's published range (`fail`), one that does not (`pass`), and one on a line Gaugeline has not confirmed (`unsure`: zod 3, Next.js 14). Their `package.json` and lockfile hold versions only.
