# plan-moved

An invented dental practice's preview and its 5-row launch plan (`plan.csv`), for `plan-moved-not-indexable`
(NAV-04). Nothing here is a real business. The plan names production addresses on `quarrylane-dental.example`;
the fixture server stands in for the preview.

- `/` and `/contact` are not moved: never judged for this check.
- `/prices` (moved from `/old/fees`) can be indexed: fine.
- `/treatments` (moved from `/old/treatments`) says noindex in its robots meta tag: a finding.
- `/team` (moved from `/old/staff`) sends `X-Robots-Tag: noindex`: a finding.
- All three old addresses 301 to the right page, so the 301 map checks pass.
