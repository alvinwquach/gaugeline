# Every check

<!-- Generated: the list below comes from docs/checks.data.json, which pnpm gen:checks writes from the check registry. Do not edit the list by hand; change the check in packages/core/src/checks/. -->

What each check catches, why it matters, and how to fix it. Sorted by urgency.

Check ids are stable: an id that has shipped is never removed without a deprecation, or reused
(see [STABILITY.md](https://github.com/alvinwquach/gaugeline/blob/main/STABILITY.md)). Titles and wording may improve.

Each check has a level from the report: **Fix this first**, **Fix soon** or **Worth knowing**.
Each check shows **Since vX**: the release that first shipped it. A check that has not been released
yet shows the version the next release will have, marked "(next)". A released check's version never
changes.

Link to one check with `/docs/checks?id=<id>` or `/docs/checks#<id>`.

<ChecksList />
