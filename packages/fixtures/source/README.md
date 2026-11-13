# source

Invented project folders for the checks that read a repository (batch FF). Nothing here is a real business.

- `<check-id>/fail/` and `<check-id>/pass/`: the smallest folder that makes the check raise a finding, and the same folder fixed.
- `harbour-bar-preview/`: a bar's pre-launch copy with the three indexing problems at once, used by the docs example for `gaugeline source`.
- `harbour-bar-switch/`: a bar whose indexing switch accepts more than `true` and whose CI tests noindex only on previews, used by the docs example for the two checks that read them.
