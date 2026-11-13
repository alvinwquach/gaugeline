# nav-events-csv

The invented coffee roastery of `nav-events`, with its tracking spec written as a spreadsheet export
(`gaugeline.events.csv`) instead of `gaugeline.events.json`, for the CSV reader and `events-unlisted` (NAV-06).
Nothing here is a real business. The pages are served from `nav-events`.

- Row 2 is the same plan line as `nav-events/gaugeline.events.json`: every nav link sends `menu_click` with three parameters.
- Row 3 names a `button.book` element the pages do not have: it is read and finds nothing to click.
