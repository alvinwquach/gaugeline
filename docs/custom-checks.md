# Your own checks

Write a rule for something only your client's site needs, in about ten lines.

Marlowe Physio is an invented clinic. Every page must show the opening hours, because the front desk gets calls when they are missing. No built-in check knows that, so the agency writes one in `gaugeline.config.mjs`:

```js title=gaugeline.config.mjs
import { defineCheck } from "gaugeline";

const hoursListed = defineCheck({
  id: "hours-listed",
  area: "Visitors",
  severity: "medium",
  title: "The opening hours are not on the page",
  what: "No line on this page says when the clinic is open.",
  why: "People look for the hours first, and phone the front desk when they cannot find them.",
  fix: "Add the opening hours to the footer, which every page shares.",
  tech: "No heading or link text on the page contains the word hours",
  size: "S",
  done: "Every page mentions the opening hours.",
  estimateChanges: "One footer partial; more if the hours come from a CMS field.",
  run: (page) =>
    [...page.headings.map((h) => h.text), ...page.links.map((l) => l.text)].some((t) =>
      /hours/i.test(t),
    )
      ? []
      : [
          {
            checkId: "hours-listed",
            severity: "medium",
            title: "The opening hours are not on the page",
            evidence: "no heading or link mentions hours",
            url: page.finalUrl,
          },
        ],
});

export default { custom: [hoursListed], checks: { "hours-listed": "block" } };
```

`defineCheck` is exported from the package's public entry (`import { defineCheck } from "gaugeline"`), so install it in the project: `npm install --save-dev gaugeline`. It throws, naming what is missing, when the id is not kebab-case, when a text is empty or when `size` is not `S`, `M` or `L`.

## The rules

- **A custom id must not collide with a built-in.** `gaugeline.config.mjs: custom.0.id: "canonical-elsewhere" is already a built-in check (or another custom check).` is exit 2 before any request. Every id Gaugeline ships is reserved, including the ones a flag such as `--wordpress` adds.
- **Plain rules.** The same page gives the same findings. No model calls in a check.
- **A smaller context.** Your check gets the page, `warn`, `couldNotCheck`, the clock and a `fetcher` with `get` only (GET and HEAD, through the same guard that refuses private addresses). It does not get `query` (the one POST path, for adapters), the owner-consent value or the site readers. What it returns is checked: a finding must carry its own check id and a level of high, medium or low, or the check fails and is reported as one that could not run. Code in the file can import anything Node can, so keep to the context.
- **A check that throws is isolated** like a built-in: the run goes on, and the output says `1 check could not run: hours-listed`.
- **Rule 14 applies to you.** A check that asks for non-public paths (`/.env`, `/.git`, admin pages) is a probing check: nothing gates it for you, so run it only on sites you own or have permission to test.
- **Same reporting.** Custom findings are in the report, the baseline and `suppress` like any other, and `"checks"` can make them `block`, `warn` or `off`.

A custom check needs `gaugeline.config.mjs`, `.js` or `.ts`, and those run code (Gaugeline prints `Running code from ...` each time, and `--config-json-only` refuses it): read [the safety note](/docs/config#json-is-the-safe-default) first. TypeScript gets the types of `defineCheck`, `Check` and `Finding` from the same import.
