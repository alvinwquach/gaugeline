# Switches, sold out and capacity: does the site agree?

Available from version 0.2.0.

Owners flip things. Pre-orders go off because the masa ran out. The kitchen marks the smash burger as
86'd at seven o'clock. The hundredth dish of the night is sold. Each of those is one change in a CMS
or a database, and the website has to follow it **everywhere at once**: the menu, the QR page, the
order page, the header link, the Menu structured data that Google and the assistants repeat. When it
does not, a customer orders a dish that is gone, or follows a link to a page that no longer takes
orders, and the owner finds out from them.

Gaugeline reads the state from where the owner changes it (a Sanity field, or a query on your
database), reads the pages you name, and tells you where the site disagrees. You say once what
"agrees" means for each state, because only you know that "off" means "say order at the bar":

| Check                        | Level          | It says so when                                                                         |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `switch-off-still-linked`    | Fix this first | A switch is off and a page still links to a page it controls.                           |
| `switch-page-wrong`          | Fix soon       | The controlled page does not say what you wrote for the current state.                  |
| `item-unavailable-shown`     | Fix this first | An item marked unavailable is on a listed page or in the page's Menu structured data.   |
| `capacity-zero-not-sold-out` | Fix this first | Nothing is left and the page does not say it is sold out (and may still take an order). |

They read and never write: the pages are fetched with `GET`, the state is read with a published-only
Sanity query or a read-only database transaction, and nothing is ever submitted. Run them only against
sites and databases you own or have permission to read.

## Example: a pop-up kitchen with pre-orders and a 100-dish cap

Marigold Tamales (invented, like every business on this page) is a weekend tamal pop-up. The freelancer
who built the site on Next.js and Vercel gave the owner two controls. A **pre-orders switch** in
Sanity (`siteSettings.features.preOrders`) turns pre-ordering on and off, and the kitchen's **100-dish
cap** counts what is left in a Supabase table. The owner switches pre-orders off and sells out the
cap, and the site does not notice: the header still says "Pre-order", `/order` still says "Pre-orders
are open", and the menu still lists a tamal the kitchen stopped making.

**1. Say what each state means.** `gaugeline.switches.json` sits next to your other Gaugeline files.
It holds names, paths and phrases, never a key:

```json title="gaugeline.switches.json"
{
  "switches": [
    {
      "id": "preorders",
      "source": "sanity:siteSettings.features.preOrders",
      "whenOff": {
        "noLinksTo": ["/order"],
        "pageSays": { "/order": "order at the window" }
      }
    }
  ],
  "availability": [
    {
      "source": "db:eightySixed",
      "items": "name",
      "mustNotAppearOn": ["/menu"],
      "alsoIn": "menu-jsonld"
    }
  ],
  "capacity": [
    {
      "source": "db:tonightRemaining",
      "whenZero": { "pageSays": { "/order": "sold out" } }
    }
  ]
}
```

Read it aloud. While `preorders` is off, no page may link to `/order`, and `/order` must say "order at
the window". Anything in the `db:eightySixed` list must not be on `/menu`, nor in its Menu structured
data. When `db:tonightRemaining` is zero, `/order` must say "sold out".

**2. Say where the numbers live.** `sanity:` sources read one field of the published document
(`SANITY_PROJECT_ID`, and `SANITY_TOKEN` only for a private dataset: see
[Sanity as a source](/docs/products-and-prices)). `db:` sources are named queries in
[`gaugeline.sources.json`](/docs/connectors/postgres), which holds the SQL and the name of the
variable with the connection string, never the string:

```json title="gaugeline.sources.json"
{
  "sources": {
    "db": {
      "type": "supabase",
      "env": "MARIGOLD_SUPABASE_DB_URL",
      "queries": {
        "eightySixed": "select name from menu_items where available = false order by name",
        "tonightRemaining": "select 100 - coalesce(sum(quantity), 0) as value from pre_order_lines where night = current_date"
      }
    }
  }
}
```

A query that gives a number or a switch returns **one row**, and its column is called `value` (or it
is the only column). A query that gives the 86 list returns one row per item, with the column that
`items` names. Make the role that runs them able to `select` only those tables, as the
[database page](/docs/connectors/postgres) shows; every statement is also checked before it is sent
and runs inside a read-only transaction.

**3. Run it.** With the two files in the folder and the variables set:

```sh title=Terminal untested="Needs Sanity and a database. packages/cli/src/__tests__/switches-docs.test.ts runs this page's commands against a recorded Sanity answer, a stand-in Postgres and the invented marigold.example site, and compares the output."
$ SANITY_PROJECT_ID=mar1gold MARIGOLD_SUPABASE_DB_URL=... npx gaugeline marigold.example
```

```text title="Output (the lines these checks add)"
✗ Nothing is left, but the page still looks open for orders
    db:tonightRemaining has 0 left, and /order does not say "sold out"; it still has an order form.
✗ An item that is sold out or off the menu is still listed
    db:eightySixed marks an item unavailable, but /menu still shows "Tamal de rajas" (the database has "Tamales de rajas").
✗ An item that is sold out or off the menu is still listed
    db:eightySixed marks an item unavailable, but the Menu structured data of /menu still has "Pozole rojo".
✗ A switch is off but the site still links to what it controls
    preorders is off (sanity:siteSettings.features.preOrders), but / still links to /order ("Pre-order", "pre-order for tonight").
✗ A switch is off but the site still links to what it controls
    preorders is off (sanity:siteSettings.features.preOrders), but /menu still links to /order ("Pre-order").
! A page does not say what it should for the current switch
    preorders is off (sanity:siteSettings.features.preOrders), and /order does not say "order at the window".
```

Every line names the rule, the page and the state, so the finding explains itself: the header link
and the menu link are the two places still sending customers to `/order`, `/order` itself is the
page that never learned the switch was off, and the menu was built from a copy of the 86 list that is
out of date. "Tamal de rajas" is how the page writes the dish and "Tamales de rajas" is how the
database does: Gaugeline treats a plural or an accent as the same word, and shows you both so you can
see why it matched. The line about the Menu structured data is the one a search engine would repeat
a day later.

## Example: the 86 list at a bar

The Copper Lantern (invented) keeps its 86 list in a Supabase table that the kitchen updates from a
tablet. The site lists the kitchen menu on `/menu` and `/tonight`, and has Menu structured data on
`/menu`. One rule covers all of it:

```json title="gaugeline.switches.json (the bar)"
{
  "availability": [
    {
      "id": "eighty-six",
      "source": "db:eightySixed",
      "items": "name",
      "mustNotAppearOn": ["/menu", "/tonight"],
      "alsoIn": "menu-jsonld"
    }
  ]
}
```

```json title="gaugeline.sources.json (the bar)"
{
  "sources": {
    "db": {
      "type": "supabase",
      "env": "LANTERN_SUPABASE_DB_URL",
      "queries": {
        "eightySixed": "select name from kitchen_items where eighty_sixed order by name"
      }
    }
  }
}
```

With "Fried pickles" and "Smash burgers" on the 86 list, the menu still shows both and its structured
data still has the burger:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/switches-docs.test.ts runs this page's commands against a stand-in Postgres and the invented lantern.example site, and compares the output."
$ LANTERN_SUPABASE_DB_URL=... npx gaugeline lantern.example
```

```text title="Output (the lines this check adds)"
✗ An item that is sold out or off the menu is still listed
    eighty-six (db:eightySixed) marks 2 items unavailable, but /menu still shows "Fried pickles", "Smash Burger" (the database has "Smash burgers").
✗ An item that is sold out or off the menu is still listed
    eighty-six (db:eightySixed) marks an item unavailable, but the Menu structured data of /menu still has "Smash burger" (the database has "Smash burgers").
```

`/tonight` is clean, so it is not mentioned. An item is found when its words stand on their own: at
the start of a line or after punctuation, and before a price, punctuation or the end of the line.
That is why an 86'd "Tamal" is not found inside "Tamal de rajas $6", which is another dish.

## The file

`gaugeline.switches.json` has three lists. Use any of them; use at least one.

### `switches`

| Field     | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `id`      | Lower-case words joined by hyphens. Unique in the file.                                        |
| `source`  | Where the on or off value lives: `sanity:<type>.<field>` or `db:<query>` (see below).          |
| `whenOff` | What the site must do while it is off: `noLinksTo` (paths no page may link to) and `pageSays`. |
| `whenOn`  | Optional: `pageSays`, what a page must say while it is on.                                     |

A value is on or off when it is `true` or `false`, `1` or `0`, or one of these words in any case: `on`,
`off`, `yes`, `no`, `enabled`, `disabled`, `open`, `closed`. Anything else, or a field that is not
set, is **not known**, and Gaugeline will not guess.

`noLinksTo: ["/order"]` covers `/order`, `/order/` and anything under it (`/order/checkout`), not
`/order-history`. It looks at the page you checked, the few other pages the run reads anyway, and every
page the file names, and skips the controlled page itself.

### `availability`

| Field             | Meaning                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`              | Optional; needed when two rules share a source.                                                                   |
| `source`          | `db:<query>`, or `sanity:<type>.<field>` where the field is a list of names.                                      |
| `items`           | For `db:` sources, the column that holds the item name. Leave it out for Sanity.                                  |
| `mustNotAppearOn` | The pages an unavailable item must not be on (at most 10).                                                        |
| `alsoIn`          | `"menu-jsonld"`: also look in the `MenuItem` names of the structured data of those pages and of the page checked. |

An empty list means nothing is unavailable. A Sanity document with no such list set counts as empty;
no such document at all is not known.

### `capacity`

| Field      | Meaning                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `id`       | Optional.                                                                                         |
| `source`   | Where the number left is read. One whole number.                                                  |
| `whenZero` | `pageSays`: what each page must say once it is zero. A negative number (oversold) counts as zero. |

### Sources

| Source                                   | What is read                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sanity:siteSettings.features.preOrders` | The first published `siteSettings` document, field `features.preOrders`. Drafts are never read. Names are plain identifiers; nothing else is allowed into the query. |
| `db:eightySixed`                         | The named query `eightySixed` in `gaugeline.sources.json`. If two sources have a query of that name, write `db:<source>.<query>`.                                    |

A `db:` source that names no query is a mistake in the files: it stops the run with exit 2, naming the
file and the source, before anything is requested.

## What "says" means

`pageSays` is a phrase match on the page as it is sent, without JavaScript. It ignores **case,
accents, extra spaces and punctuation** ("Sold out!" matches `sold out`), needs the words in a row
and whole (`sold out` is not found in "sold outside"), and does not match across two lines of the page.
Text a visitor cannot see (`hidden`, `aria-hidden`, `display:none`, scripts) does not count.

For a bilingual site give a phrase per language:

```json title="One phrase per language"
"pageSays": { "/order": { "en": "order at the window", "es": "pida en la ventanilla" } }
```

If the site's language scheme is in `gaugeline.languages.json`
([Checking language versions](/docs/guides/languages)), Gaugeline reads each language's version of
the page (`/order` and `/es/order`) and expects that language's phrase on it. Without one, the page's
`lang` attribute picks the phrase, and a page in a language you gave no phrase for may say any of them.

## When the page is cached

"I switched it off and it still shows" is, most of the time, a cached copy. When the page that
disagrees came back with an `Age` header (a CDN or the browser-facing cache says it has held that copy
for some time, [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111#name-age)), the finding says so:

```text
preorders is off (sanity:siteSettings.features.preOrders), and /order does not say "order at the window". The answer was served from a cache: Age 3140 (52 minutes old), Cache-Control: public, s-maxage=3600. It may show the old state until it expires or is purged.
```

That saves the first ten minutes: purge the cache (or revalidate on the switch's change), then run
again. A page with no `Age` header gets no such line. It does not prove the page was not cached.

## When a source cannot be read

A rule whose source cannot be read is listed under "could not check" with the reason. It is never a
pass and never a finding, because a state nobody could read is not a state:

| What happened                                                            | What you see                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANITY_PROJECT_ID` or the connection variable is not set                | "could not check", naming the variable. Nothing is requested.                                                                                            |
| Sanity or the database refuses, times out or is down                     | "could not check", with what the source said (keys and passwords are replaced with `[redacted]`).                                                        |
| The value is not on or off, not a number, or the query returned two rows | "could not check", showing the value (escaped) and the values that are accepted.                                                                         |
| A named page cannot be read (403, a bot challenge, no answer)            | "could not check" for the checks that needed it. A page that answers 404 is silent for the link and item checks, and "could not check" for what it says. |

## Limits

A run reads at most **16** different pages named in the file (the checked page does not count: it is
already read; the [freshness file](/docs/guides/data-freshness) draws from the same 16), each once with `GET`. Each Sanity field is read once per run with one `GET`, and the
named queries share the one read-only database connection the other checks use. There are no flags to
raise the limit: it is a promise to the site being checked. The checks are not run at all unless
`gaugeline.switches.json` exists, so a site without one is never asked for these pages.

## Common questions

**Why not guess what "off" should look like?** Only you know that "off" means "say order at the
window" and not "redirect to the menu". Writing it down makes the finding exact and self-explanatory.

**Where do I put the secret?** You do not. Names and queries are in the files; the connection string
is in the variable the source names, and a Sanity token (only for a private dataset) is in
`SANITY_TOKEN`. Neither is ever printed.

**Does it work with Next.js on Vercel?** Yes, it reads the deployed pages. If your pages are cached
at the edge, set a short `s-maxage` or purge on the switch's webhook, and read the `Age` line above.
