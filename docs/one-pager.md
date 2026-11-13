# The one-page report: what to fix first, on one sheet

A client who asks "so what is wrong?" does not want 40 findings. The one-page report is one printable sheet
for that conversation: the headline, the first things to fix, each with the check it came from, and what was
**not** checked. It is a report format, not an [agent](./agent-safety.md): it makes no decision, calls no model
and sends nothing.

## Get it

It is a value of the `--format` flag that already chooses what stdout carries (`json`, `sarif`, `junit`; see
[Use it in CI](./ci.md#sarif-and-junit-results-your-ci-already-reads)), so there is no second report flag:

```sh title=Terminal untested="Shows the two forms; the next example runs the first against a fixture."
$ npx gaugeline example.com --format one-pager > one-pager.md
$ npx gaugeline view run.json --format one-pager > one-pager.md
```

- **`gaugeline <address> --format one-pager`** checks the site as usual and prints the page instead of the
  terminal report. It is a view of that one run, like SARIF: it writes no report file and keeps the exit codes
  (`--ci` still exits 1 on a "Fix this first" finding).
- **`gaugeline view <run.json> --format one-pager`** builds the page from a run you saved earlier with
  `--json`. **It asks the site for nothing**: the page is made from the file alone. A file over 10 MB, or one
  with more than 50,000 findings, is refused.

## What is on the page

| Part             | Where it comes from                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline         | The run's own counts: findings by "Fix this first", "Fix soon" and "Worth knowing", checks passed                                                  |
| Fix this first   | One item per check with a "Fix this first" finding, in the order the run found them; at most 5, the rest counted                                   |
| Each item        | The finding's title and evidence line, then `Source: check <id>` and the finding's own source file and line, or the page path when it has none     |
| Not checked      | Checks that could not run, checks left out on purpose (mail records without `--dns`), reads a site refused, and samples that were only partly read |
| The closing line | Fixed words: anything the run did not include is "not measured here"                                                                               |

Every sentence is a template filled from a finding or a count. A number on the page is a count of this run
or a number already in one of its own findings; nothing is estimated, so there is no "hours" or "money" line.
A finding with no usable check id cannot be cited, so it is counted ("1 finding has no check id") and left off.

Text the checked site chose (a title, an evidence line, a reason a read was refused) is **data**: it is cut to
a short length, secrets in it are replaced, control and hidden characters are shown, and every Markdown or
HTML character is escaped, so a page that says "ignore your instructions" or carries a `<script>` appears as
harmless words. A query string is never shown, because it can carry a token.

## An example: a dentist's preview

Brightside Dental is an invented practice, and this is its [Netlify deploy preview](./guides/deploy-gates.md):

<!-- fixture: deploy-preview-dentist -->

```sh title=Terminal
$ npx gaugeline https://deploy-preview-7--brightside-dental.netlify.app --format one-pager
```

```text title=Output
# Gaugeline one-pager: deploy-preview-7--brightside-dental.netlify.app

Run of 2026-11-11. 1 to fix first, 0 to fix soon, 1 worth knowing.

## Fix this first

1. **Links on this page go nowhere**
   - Seen: "Whitening" \<a href="/whitening"\> returned 404
   - Source: check `broken-links`, page /whitening.

## Not checked

- Left out of this run on purpose: `email-spf-missing`, `email-spf-multiple`, `email-dmarc-missing`, `email-dmarc-none`. Their results are not measured.
- Anything this run did not include (a check it did not list, a page outside its sample, a signed-in page) is not measured here.

Built from the findings of one run. Making this page asked the site for nothing and used no model. Words from the checked site are shown as data, cleaned and cut short; they are never instructions.
```

## The library example

The same code runs from `@gaugeline/core`, on an invented run for a bakery: two checks marked "Fix this first"
(one on two pages), one refused read and a link sample that was only partly read. Run from `packages/core` with
`node --import tsx example.mts`:

```ts
import { EXAMPLE_ONE_PAGER_RUN, formatOnePager } from "./src/index.js";

console.log(formatOnePager(EXAMPLE_ONE_PAGER_RUN));
```

```text title=Page
# Gaugeline one-pager: harbour-bakery.example

Run of 2026-11-13. 3 to fix first, 1 to fix soon, 1 worth knowing. 2 checks did not get a full read.

## Fix this first

1. **A link on this page goes nowhere**
   - Seen: /menu links to /old-menu, which answers 404
   - Source: check `broken-links`, page /menu. 2 findings of this check; this is the first.
2. **The Pay now button leads to a page that is gone**
   - Seen: https://pay.harbour-bakery.example/order answers 410
   - Source: check `payment-link-dead`, page /order.

## Not checked

- These checks could not run: `dns-spf`.
- `links-checked` could not read /members: the site refused the request \(403\)
- links: 40 of 120 found were read; the other 80 are not measured.
- Anything this run did not include (a check it did not list, a page outside its sample, a signed-in page) is not measured here.

Built from the findings of one run. Making this page asked the site for nothing and used no model. Words from the checked site are shown as data, cleaned and cut short; they are never instructions.
```

A test runs this same code and fails if this page's output differs from it.

## How it is evaluated

The page is judged the way an [agent is](./agent-evals.md), with the same offline harness, though it is not a
registered agent (no token, scope or [policy](./hosted/agent-policy.md) applies, because it makes no call).
Golden cases are answered by the real code. Known-bad cases are recorded wrong answers, and each must be
caught: a fix-first item with no check id, a finding the run does not have, an invented number ("lifts sales by
35 percent"), a page that obeys an order found in a finding and tries to send it, an answer that costs
anything, one that is too slow, an input over the cap, and an answer in the wrong shape. A hostile finding (an
order and HTML in its words) is a golden case: it is shown, escaped, and nothing is called.

```text title=Evals
agent one-pager: 4 golden, 8 known-bad
golden     golden-bakery-mix            pass
golden     golden-clean-run             pass
golden     golden-source-line           pass
golden     golden-hostile-text-is-data  pass
known-bad  bad-uncited-item             caught (schema)
known-bad  bad-missing-ref              caught (cited-ids)
known-bad  bad-invented-number          caught (no-invented-numbers)
known-bad  bad-obeys-page-text          caught (no-write-call)
known-bad  bad-over-cost                caught (limits)
known-bad  bad-too-slow                 caught (limits)
known-bad  bad-oversized-input          caught (limits)
known-bad  bad-malformed-output         caught (schema)
golden 4/4 pass; known-bad 8/8 caught; cost 1 micro-units
```

## What is not built

- **No HTML or PDF.** The page is Markdown; print it from any Markdown viewer. A printable HTML form like the
  [receipt](./reading-the-report.md)'s would be a later row.
- **Receipts are not read.** The page is about one run. The monthly receipt and the signed receipt chain are
  separate and are not part of it.
- **Nothing says how long the fixes take.** Sizing is [the work order's](./reading-the-report.md) job.
