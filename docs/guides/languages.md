# Checking language versions

A bilingual site breaks quietly: a Spanish page is missing, points its hreflang at the wrong twin,
or shows last month's price. These checks pair the checked page with its versions in other
languages and compare them.

## How versions are found

- The page's `<link rel="alternate" hreflang="...">` links.
- The sitemap's `<xhtml:link rel="alternate" hreflang="...">` entries for the page.
- Your language settings in `gaugeline.languages.json`, in the folder you run Gaugeline from (it
  moves into the config file when that arrives):

```json
{
  "prefixes": { "en": "/", "es": "/es/" },
  "default": "en",
  "exclude": ["/press/*"],
  "untranslated": ["Order now", "Add to cart"]
}
```

`prefixes` (or `subdomains`, such as `{ "es": "es." }`, or `param`, such as `"lang"`) says how a
page's twin is addressed: `/menu` and `/es/menu` share the key `/menu`. `exclude` lists pages meant
to exist in one language only. `untranslated` lists default-language strings that must not appear
on another version. `priceSelector` is a CSS selector for the price when a page has no structured
data offers.

At most 5 versions are fetched per run (see [Security](../security.md#how-much-a-run-requests)).

## Prices

Prices come from structured data first (Product and Offer `price`), then your `priceSelector`, and
never from free text, which is the fastest way to false alarms. `$12`, `12 USD` and `$12.00` are
the same price. When only some versions have prices, the check says it could not compare them; a
page that sells nothing has nothing to compare.

## Example

Against the invented `bilingual-popup` fixture, a pop-up whose French page doesn't exist and whose
Spanish page has an old price, version 0.1.0 prints:

```text title=Output
✗ Prices differ between language versions
    TAMAL-BOX: 12.00 USD on / (en), 14 USD on /es/ (es)
! A language version of this page is missing
    1 of 2 language versions are missing: fr /fr/ returned 404

Checked all 2 sitemap pages, all 2 language versions.
2 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/languages.test.ts`.
