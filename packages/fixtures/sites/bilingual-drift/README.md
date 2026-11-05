# bilingual-drift

An invented bakery whose Spanish page has drifted from the English one, for the language checks the
bilingual-popup fixture doesn't reach:

- hreflang-not-reciprocal: `/es/` has no hreflang links back to `/`.
- hreflang-bad-code: the homepage uses `es_MX` (an underscore).
- lang-attr-mismatch: `/es/` still says `<html lang="en">`.
- lang-untranslated: "Order now" is on `/es/` (listed in `gaugeline.languages.json`).
