# plan-redirects

An invented bookshop's preview and its 9-row launch plan (`plan.csv`) with a Legacy URL column, for
the 301 map check (G18). Nothing here is a real business. The plan names production addresses on
`lanternbooks.example`; the fixture server stands in for the preview.

What must pass:

- `/fiction` claims two old addresses in one cell (a line break between them), and both 301 there;
  one is written as an absolute `www.` address.
- `/old-kids` redirects with 308 to the right place: accepted, with a note.
- `/shop`'s legacy address is its own address: no redirect needed, not requested.

Five planted errors, one each:

- `/old-poetry`: 302, not 301 (plan-redirect-not-301).
- `/old-events`: 301 to `/old-events/`, then 301 to `/events` (plan-redirect-chain).
- `/old-gifts`: 301 to `/shop`, the plan says `/gifts` (plan-redirect-wrong-destination).
- `/old-about`: the old page still answers 200 (plan-redirect-missing).
- `/old-blog?tag=news`: 301 to `/blog`, the query string dropped (plan-redirect-drops-query).
