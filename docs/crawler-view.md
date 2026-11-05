# What a crawler gets

When an audit says your pages return no HTML, this settles it in one command.

React frameworks preload pages in the background. Those requests carry a prefetch header and return the framework's data format (`text/x-component`), not HTML. A crawler that renders JavaScript can record the preloads instead of the pages, and the report then claims your site returns no HTML.

## What Gaugeline records

- A normal request, with its content type and how many words a search engine can read
- The same address with the prefetch header, which is expected to return app data
- Whether the response tells caches the two differ (`Vary: RSC`)

::: warning
The real bug in this area: serving both formats from one address **without** `Vary: RSC`. A shared cache can then hand the data format to a visitor or a search engine. Gaugeline flags that as high.
:::

## Re-check an audit export

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline verify crawl-export.csv --limit 40
```

It reads the address column and the issue name if there is one, sets aside rows that aren't pages, resolves prefetch rows back to the pages they belong to, and checks those directly. In one real audit, 4,061 of 4,180 "orphan URLs" were prefetch payloads.

- **If you own the site:** This is the one that saves your developer an afternoon of proving nothing is broken.
- **If you run marketing:** If an SEO report says your pages are missing, run this before anyone panics.
- **If you edit content:** Nothing to do here.
- **If you build the site:** Also useful after a deploy: confirm the pages an audit flagged are clean without waiting for the next crawl.
