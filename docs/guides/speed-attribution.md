# Speed attribution: which change makes the page faster

A slow page usually has one thing behind most of the slowness: a chat widget that holds the page for most of a
second, an intro animation the page waits for, a script that has to run before the main text appears. A speed
score does not say which. `--attribution` finds out by taking things away, one at a time, and reporting which
of them moves the page's **total blocking time** or its **Largest Contentful Paint** (how soon the main thing
on the page appears), and by how much.

It needs the browser you installed ([Rendered pages](../rendered-pages.md)), so it is used with
`--renderer playwright`. It is off unless you ask for it, and it is read-only.

```sh
npx gaugeline pantry.example --renderer playwright --attribution
```

## What it does

The checked page is loaded in the browser on your computer **five times, one after the other**:

| Load | What is different                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 1, 2 | Nothing: the page as a visitor's browser loads it. Two loads, to see how much two identical loads differ              |
| 3    | **Reduced motion forced.** The page is told the visitor asked for less motion (`prefers-reduced-motion: reduce`)      |
| 4    | **JavaScript off.** No script of the page runs                                                                        |
| 5    | **Scripts from other sites blocked.** A script that comes from another site than the page's is refused, not requested |

Each change can only take something away. A refused script is never requested (the gate refuses it on the address
the page names and on every address a redirect names, and it counts towards the request cap), "another site" means
another registrable domain (`cdn.site.co.uk` is the site's own, `evil.co.uk` is not `site.co.uk`'s), JavaScript off makes the page
do less, and every other rule of the renderer holds as it does for any rendered page: only `GET` and `HEAD`,
no private addresses, nothing clicked or submitted. A test asserts that every address a changed load asks for
was also asked for by the plain load.

## What it reports

For each change and each of the two numbers, the change is reported **only when it moves the number by more
than all three of**: how far the two plain loads differ from each other, a floor (200 ms for Largest
Contentful Paint, 100 ms for blocking time) and 10% of the plain loads' mean. A smaller difference is noise,
and nothing is said. A change for the worse is reported too.

- **Total blocking time** is the time every long task spent over 50 ms. Here it counts from the start of the
  load, not from first paint, so it is not the number Lighthouse shows. It is collected by an observer that
  Gaugeline's script creates before the page's own scripts run, and it is never more than the load took. **With
  JavaScript off it is not measured** (no script runs, so there are no long tasks to observe): that comparison is
  could not check, never "0". A page whose reports cannot be real (more than 200 long tasks, one under 50 ms or
  longer than the load, or all together longer than the load) is judged to have tampered: its blocking time is
  could not check, not a number.
- **Largest Contentful Paint** is the last candidate the browser reports, in milliseconds from just before
  Gaugeline asked the browser for the page.

Every finding is low severity: it is advice about where to look. The numbers are this computer's browser,
unthrottled, once or twice: use them to compare one change with another, not with Lighthouse and not with what
visitors measured ([Speed](./pagespeed.md) is for that).

## What it cannot say

- **A page can fool its own measurement.** The observer reports to a function on the node side, and a page that
  goes looking can call that function itself and say what it likes. Reports that cannot be real are caught and
  the page's blocking time is dropped; a page that invents plausible tasks, or holds the thread without being
  seen, is not. This is advice for the owner of a site who runs it on their own site, not a security boundary:
  the report says what the browser saw, not that the page is honest.
- **Speed Index** is not measured. It is computed from a video of the page loading, which Gaugeline does not
  record. Every run says so once under could not check.
- A page that shows **less than half its text without JavaScript** is not compared for that change: it is a
  different page without scripts (a "Loading..." screen), so its timings would not be like for like.
- A load that could not be made (no browser, a cap, a page that does not answer) or a number the browser did
  not report is could not check for that change. The others are still compared. It is never a pass.
- The five loads count towards the run's cap of 10 rendered pages and its five minutes.

## Example: Corner Pantry

Corner Pantry is an invented shop. Its home page waits 1.5 seconds before it shows its main paragraph unless the
visitor asked for less motion, and its chat widget holds the page for about 800 milliseconds.

```text title="Terminal" untested="Needs a browser installed on the machine, and the numbers differ on every computer. packages/renderer/src/__tests__/variants.e2e.test.ts runs the five loads in a real browser against an invented page like this one, and packages/cli/src/__tests__/attribution.test.ts runs this command in memory with a stand-in browser that answers with the invented numbers below, and checks that every line below is in what it prints."
$ npx gaugeline corner-pantry.example --renderer playwright --attribution
```

```text title="Output (other checks' lines left out; the numbers are invented)"
· Which change moves the page's blocking time or Largest Contentful Paint (advice)
    With reduced motion forced, Largest Contentful Paint went from 1630 ms to 940 ms (690 ms faster; the two plain loads differed by 40 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.
· Which change moves the page's blocking time or Largest Contentful Paint (advice)
    With JavaScript off, Largest Contentful Paint went from 1630 ms to 150 ms (1480 ms faster; the two plain loads differed by 40 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.
· Which change moves the page's blocking time or Largest Contentful Paint (advice)
    With scripts from other sites blocked, total blocking time went from 840 ms to 110 ms (730 ms faster; the two plain loads differed by 20 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.
? perf-attribution could not be checked: Total blocking time is not measured with JavaScript off: no script runs, so there are no long tasks to observe, and it is not compared. (/)
? perf-attribution could not be checked: Speed Index was not measured: it needs a video of the page loading, which Gaugeline does not record. (/)
```

Reading it: the intro animation costs about 700 ms before the main text appears (reduced motion fixes that
for visitors who asked for it, and the page should not hold content back for anyone), and the third-party
scripts account for about 730 of the 840 ms of blocking time. Load the widget later or drop it, and
the intro should not gate the content.

## For developers

The renderer's request takes two optional fields, `variant` (`reducedMotion`, `javaScript: false`,
`blockThirdPartyScripts`) and `measure`, and its answer then carries `performance` (`lcpMs`, `tbtMs`,
`scriptsRefused`). The numbers come from the browser's own DevTools timeline (which works with JavaScript off)
and a long-task observer installed before the page's scripts; what the page could have written is read as
plain numbers and bounded. The comparison is a pure function (`attributeSpeed` in
`packages/core/src/render/attribution.ts`) with whole milliseconds in and out, and the check is
`packages/core/src/checks/perf-attribution.ts`, added to a run's registry only with `--attribution`.
