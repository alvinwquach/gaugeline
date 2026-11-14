# Config, baselines and suppressions

Choose which checks block a deploy, accept the findings you already know about, and snooze one with a date so nothing is muted for ever.

Fernhill Taproom is an invented neighbourhood bar. An agency took it on in November with a site that already had six findings. Nobody wants the build to fail on problems that were there on day one, and nobody wants a new one to slip in unseen. Three things do that: a config file, a baseline and suppressions.

## The config file

Put `gaugeline.config.json` in the folder you run Gaugeline from. It is read from that folder only: never from a parent folder and never from a site Gaugeline is checking.

```json title=gaugeline.config.json
{
  "checks": { "mailto-cta": "block", "images-legacy-format": "off" },
  "suppress": [
    {
      "id": "viewport",
      "until": "2026-12-31",
      "reason": "The phone layout ships with the December redesign"
    }
  ]
}
```

| Key        | What it does                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`   | A check id and `"block"`, `"warn"` or `"off"`. `block` makes `--ci` exit 1 for that check at any level. `warn` never fails the run. `off` does not run the check. Without an entry only a "Fix this first" finding fails. |
| `custom`   | Checks you wrote (see [Your own checks](/docs/custom-checks)). Needs `gaugeline.config.mjs` or `.ts`: a JSON file cannot hold code.                                                                                       |
| `suppress` | `id`, an optional `url` (an address or a path such as `/menu`), `until` (a date) and `reason`. All of `id`, `until` and `reason` are required.                                                                            |

An id under `checks` that no check has is exit 2 when it is set to `block` (it would block nothing for ever), and a notice for `warn` and `off`. A mistake is exit 2 with the key named, for example `gaugeline.config.json: suppress.0.until: must be a date, YYYY-MM-DD: a suppression needs an expiry`. A key the file does not know is refused by name too. There is no key for `--allow-private`, `--owner-consent` or the fetcher's guard, so a config can never switch the read-only rules off.

### JSON is the safe default

`gaugeline.config.json` is data. `gaugeline.config.mjs`, `.js` and `.ts` are programs: Gaugeline loads them with Node's own `import()`, which **runs the code in the file**, the same as an ESLint or Vite config. Use them only in a folder you trust, and never in one you just cloned from someone else and have not read. A `.ts` config needs a Node that runs TypeScript files itself (22.18 or newer, or 24); Gaugeline adds no loader of its own. Keep one file: two in the folder is an error, so no file is ignored in silence. Every run that loads a program says `Running code from gaugeline.config.mjs` on stderr, before it runs it. To refuse programs altogether, for example in a CI job that checks a pull request from a fork, pass `--config-json-only` or set `GAUGELINE_NO_EXEC_CONFIG=1`: a `.mjs`, `.js` or `.ts` config is then exit 2 and nothing is run. Custom checks still read through the run's read-only fetcher; code in your own config can do anything Node can, which is why JSON comes first.

## A baseline: only what is new

`--baseline <file>` writes the findings of this run to a file, and from then on hides what is in it.

```sh
npx gaugeline fernhill.example --baseline gaugeline.baseline.json   # writes it: nothing fails
npx gaugeline fernhill.example --baseline gaugeline.baseline.json   # later: new findings only
```

The file holds a fingerprint, the check id and the path of each finding: no host, no page text, no evidence. The fingerprint is a hash of the check, the path and the evidence with addresses' hosts and every number taken out, so a new preview host, a count that moves from 28 to 29 or a timing does not make a known finding look new. Add `--update-baseline` to accept what is found now and write the file again.

Fernhill's baseline was written on 2 November and holds four of its findings. This run reads the config above too, so the phone-screen finding is snoozed and the old-image-formats check is off:

<!-- fixture: fernhill-config -->
<!-- exit: 1 -->

```sh title=Terminal
$ npx gaugeline fernhill.example --ci --baseline gaugeline.baseline.json
```

```text title=Output
! Some buttons open an email instead of a form
    Opens an email instead of a form: "Book a table" (mailto:tables@fernhill.example).
· Shared links have no picture
    no og:image on https://fernhill.example/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, none to fix first.
```

On stderr Gaugeline says what it left out, whatever `--quiet` says: `2 known findings in gaugeline.baseline.json left out; 2 new.` (with `(N Fix this first)` after `left out` when some of the known ones were).

**`--json` does not list them by default.** Baselined findings, and suppressed ones, are left out of the `--json` result (schema 2, the default), so a program that reads it cannot tell a clean site from a muted one. Their trace on stderr is how many were left out and how many of those were "Fix this first". To get them in the JSON, ask for schema 3: `--json --json-schema 3` (see [Seeing what was hidden, in JSON](#seeing-what-was-hidden-in-json)). The exit code is 1 because the config sets `mailto-cta` to `block`; stderr says so too. Known findings never fail a run. A baseline that is malformed, or written by a newer Gaugeline, is exit 2 with a plain message, never a silent pass. A baseline file that does not exist yet is written by a run without `--ci` (which exits 0 and says it wrote one), or by `--update-baseline`. Under `--ci` a missing baseline is exit 2: a checkout that lost the file must fail, not write a new one and accept every finding. Commit the file.

`gaugeline query` has its own, older, narrower baseline (`--save` and `--against`, names of gaps only). It is unchanged.

## Suppressions that expire

A suppression needs a reason and a date. `until` is the last day it applies (UTC). The day after, it stops: the finding comes back and Gaugeline says so on stderr, whether or not the finding is still there, so a stale entry cannot sit in the file unnoticed:

```text
Suppression of viewport expired on 2026-12-31 (The phone layout ships with the December redesign). It no longer applies: the finding is back below.
```

For one run, without editing the file, use the flags. All three are needed, and a date in the past is exit 2:

<!-- fixture: fernhill-config -->

```sh title=Terminal
$ npx gaugeline fernhill.example --suppress og-image-missing --suppress-until 2026-12-31 --suppress-reason "Photo shoot is Friday"
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://fernhill.example/menu"> on https://fernhill.example/ (differs by path)
! Some buttons open an email instead of a form
    Opens an email instead of a form: "Book a table" (mailto:tables@fernhill.example).
· Some images have no alt attribute
    1 image has no alt: /patio.png
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, 1 to fix first.
```

A suppression that matches no finding in a run is named on stderr (a mistyped id, an address with no scheme such as `fernhill.example/menu`, or a problem that is fixed): remove it or correct it. What was snoozed is always counted on stderr, with how many were "Fix this first", even with `--quiet`.

The same is true of suppressions: `--json` leaves the snoozed findings out unless you ask for schema 3, and stderr always counts them, with how many were "Fix this first".

## Seeing what was hidden, in JSON

`--json` prints the schema 2 result unless you choose another, and a schema 2 result never gains a field, so nothing that reads it today changes. `--json-schema 3` prints schema 3: the same result with the schema number changed to `3` and four lists that say what was hidden. It needs `--json` (or `--format json`); `--json-schema 2` is the same as leaving it out; any other number is exit 2 and says which are accepted (`1` is published as `result.v1.json` for anyone who pinned it, and is not printed any more).

| Field                   | What it holds                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suppressed`            | `{ finding, by }` for each finding an active suppression hid: the finding as it would have been in `findings`, and `by`, the entry (`id`, `url` if any, `until`, `reason`) |
| `expiredSuppressions`   | Entries past their `until` date, listed whether or not their finding is still there (when it is, it is back in `findings`)                                                 |
| `unmatchedSuppressions` | Active entries that matched no finding in this run: a mistyped id, an address with no scheme, or a problem that is fixed                                                   |
| `baselined`             | The findings `--baseline` already knew and left out of `findings`                                                                                                          |

All four are always there, empty when nothing was hidden, so a program never has to ask whether a key exists. The shape is published as [`result.v3.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/schema/result.v3.json); the exit code, stderr and `--ci` behave exactly as they do with schema 2. Fernhill snoozes the missing share picture until the photo shoot:

<!-- fixture: fernhill-config -->

```sh title=Terminal untested="The output is JSON with the id of every passed check (hundreds, and one more with each new check), which the docs runner would compare whole. scripts/__tests__/docs-json-schema-3.test.ts runs this command against the fixture and compares the block below, with passed and sampled left out."
$ npx gaugeline fernhill.example --json --json-schema 3 --suppress og-image-missing --suppress-until 2026-12-31 --suppress-reason "Photo shoot is Friday"
```

The `passed` and `sampled` fields are left out below; they are the same as in schema 2. The config in this folder snoozes `viewport` too, so there are two entries:

```json title=Output
{
  "schema": 3,
  "url": "https://fernhill.example/",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "findings": [
    {
      "checkId": "canonical-elsewhere",
      "severity": "high",
      "title": "This page tells Google to show a different page",
      "evidence": "<link rel=\"canonical\" href=\"https://fernhill.example/menu\"> on https://fernhill.example/ (differs by path)",
      "url": "https://fernhill.example/"
    },
    {
      "checkId": "mailto-cta",
      "severity": "medium",
      "title": "Some buttons open an email instead of a form",
      "evidence": "Opens an email instead of a form: \"Book a table\" (mailto:tables@fernhill.example).",
      "url": "https://fernhill.example/"
    },
    {
      "checkId": "images-alt-missing",
      "severity": "low",
      "title": "Some images have no alt attribute",
      "evidence": "1 image has no alt: /patio.png",
      "url": "https://fernhill.example/"
    }
  ],
  "failed": ["email-spf-missing", "email-spf-multiple", "email-dmarc-missing", "email-dmarc-none"],
  "couldNotCheck": [],
  "suppressed": [
    {
      "finding": {
        "checkId": "viewport",
        "severity": "medium",
        "title": "This page isn't set up for phone screens",
        "evidence": "no <meta name=\"viewport\"> on https://fernhill.example/",
        "url": "https://fernhill.example/"
      },
      "by": {
        "id": "viewport",
        "until": "2026-12-31",
        "reason": "The phone layout ships with the December redesign"
      }
    },
    {
      "finding": {
        "checkId": "og-image-missing",
        "severity": "low",
        "title": "Shared links have no picture",
        "evidence": "no og:image on https://fernhill.example/",
        "url": "https://fernhill.example/"
      },
      "by": {
        "id": "og-image-missing",
        "until": "2026-12-31",
        "reason": "Photo shoot is Friday"
      }
    }
  ],
  "expiredSuppressions": [],
  "unmatchedSuppressions": [],
  "baselined": []
}
```

The `suppressed` entry carries the finding and the reason and date that hid it. The `reason` is text you wrote: it passes through the same redaction as every other string in a result, and you should still not put a password in one. Dismissals made in the terminal view (`gaugeline.ignore.json`) are not in schema 3.

Nothing is muted for ever: a permanent ignore list is how real findings disappear. (Findings you dismiss in the terminal view with `d` go to `gaugeline.ignore.json`, which has a reason but no date.)

## Exit codes

They keep their meaning: 0 ran, 1 `--ci` found something that blocks, 2 could not run. Findings that are baselined or suppressed never count towards 1.
