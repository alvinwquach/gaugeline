# $NAME$: content checks for sites built on $NAME$

What a $NAME$ site's CMS says is published, against what the live site shows. TODO(new:adapter) one sentence that says what Gaugeline reads, that it only reads, and which key (if any) it asks for.

## What this adapter reads, and the narrowest key

#if live
**The key first.** Gaugeline asks for no key for $NAME$ and reads the live site only. Its key kind is `read-only` with no key at all, because nothing it does can change anything.
#if full-access
TODO(new:adapter) say why in two sentences: $NAME$'s own key can also change the project (say what it can change, and cite the page that says so), and Gaugeline sends GET and HEAD requests through its fetcher and nothing else, so it does not ask for the key, does not read it and will not use it. If the variable the platform's own tools read is set where Gaugeline runs, Gaugeline ignores it.
#else
TODO(new:adapter) say why in two sentences: $NAME$ has no read API (say what you looked for, and cite the page that shows it), so there is nothing to ask for, and the live site is what can be read.
#end
#else
#if key
**The key first.** TODO(new:adapter) one paragraph: what key $NAME$ offers, whether it can be limited to reading, the exact permission names Gaugeline needs and nothing else, and the sentence "with it a program can read, and it cannot change or delete anything" only if the platform's documentation says so (cite it). If the platform has no read-only key, say that here first and recommend the narrowest option. Gaugeline's key kind for $NAME$ is `$KEYKIND$`.
#else
**The key first.** Gaugeline asks for no key for $NAME$: it reads the platform's public API, which answers anyone. Its key kind is `read-only` with no key at all. TODO(new:adapter) name the endpoints that are public, and cite the page that says so.
#end
#end

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: TODO(new:adapter) YYYY-MM-DD, by reading TODO(new:adapter) the pages you read, each as a link. Say plainly if a page could not be reached, and mark every unconfirmed detail `uncited`. Check this page against the platform's current documentation before relying on a detail. [docs]

#if live
## What it reads

Every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request. $NAME$'s own servers are never asked.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads. TODO(new:adapter) say where a $NAME$ site generates its sitemap, with the page that says so, or mark it `uncited`.
- The feeds the home page advertises; with none advertised, the usual places. TODO(new:adapter) say whether a $NAME$ site has a feed.

It reads the sitemap the way the [Sitemap and feeds](/docs/integrations/sitemap-feed) adapter does: only an address and its dates are kept, a title or a word of the client's text never is, and a sitemap that is missing, refused or unreadable is could-not-check, never an empty list.
#else
## What it reads

Every request is a `GET` to `$API$`, through the same fetcher as every other request. Nothing else is ever sent. TODO(new:adapter) replace the two rows with the platform's real endpoints, each with a link to its reference page.

| Endpoint                         | What for                                                              |
| -------------------------------- | --------------------------------------------------------------------- |
| `GET /v1/types`                  | The content types, with their slugs. TODO(new:adapter) reference link |
| `GET /v1/types/{type}/items`     | The items of a type: counts, fingerprints and field counts.           |

Items are read a page at a time until the total the API reports has been read. A page that is too big is asked again with half as many items, down to 10, and only then is the type could-not-check. A page that comes back short is not taken for the end of the list, and one that comes back empty before the total is could-not-check. When the platform answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial. TODO(new:adapter) cite the platform's rate-limit page.
#end
#if key

## Make the key

TODO(new:adapter) the steps in the platform's own menus, with the permission names. Put the key in the environment where Gaugeline runs, never in a file you commit:

```text
$P$_TOKEN=<the key>
```

The key goes in an `Authorization` header and never in an address, it is sent only to `$API$`, and every message, finding and report has it blanked.
#end

#if !live
### What reaches your computer

TODO(new:adapter) say whether the platform's list endpoints send each item's field data with it (and whether a parameter can leave it out). Field values are used for exactly two things: counting which items have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all.
#end

## Example: a yoga studio on $NAME$

Larkspur Yoga Studio is an invented small studio. A freelancer built its site on $NAME$: classes (one page each), teachers (one page each) and a few notices. The owner edits the content between classes and publishes from her phone. TODO(new:adapter) say what the freelancer wants to know that the adapter can answer.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "$ID$"
    }
  ]
}
```

TODO(new:adapter) run `pnpm exec tsx packages/core/src/adapters/__tests__/$ID$-docs-example.ts`, put the settings it uses in the block above, and paste its output here (a test compares them with the tool):

```json title=Output
{
  "TODO(new:adapter)": "paste the output of the docs example here"
}
```

TODO(new:adapter) read the output the way the freelancer does, in a few sentences. Show no text of the client's: only counts, ids, slugs and dates.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                                 | Answer here          | Why                                                         |
| ---------------------------------------- | -------------------- | ----------------------------------------------------------- |
| Who has access to the site (`members`)   | not offered          | TODO(new:adapter) say whether the platform lists members    |
| Whether a page shows the same words      | not decided here     | The adapter gives hashes; comparing them with the page is another check. |
#if live
| The platform's content behind the site   | could not check      | TODO(new:adapter) the reason in `$P$_CONTENT_READ_PATH`    |
#else
| Items in other languages                 | TODO(new:adapter)    | TODO(new:adapter) say which language the adapter reads      |
#end

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

#if key
- `$P$_TOKEN` is not set (nothing is asked), or the platform does not accept it (HTTP 401);
- the key lacks a permission (HTTP 403): TODO(new:adapter) name it;
#end
- an answer is not the shape the platform sends, or an item has no id or no update time;
- a type is bigger than the bound, a page of items is too big even at 10 items, or the list stops before its total.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

#if !live
## What is bounded

| Limit                          | Value  |
| ------------------------------ | ------ |
| Items in one page of a list    | $PAGE$ |
| Items read from one type       | 10,000 |

There are no flags to raise them.

#end
## Settings

| `gaugeline.adapters.json` field | What it does                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `$ID$`.                                                                                            |
#if live
| `adapters[].site`               | The site to read, when the run is not given one.                                                   |
#else
| `adapters[].fingerprint`        | Fields to hash, by type. Up to 20 per type.                                                        |
| `adapters[].urls`               | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in.     |
#end
#if key

| Environment variable | What it is                                  |
| -------------------- | ------------------------------------------- |
| `$P$_TOKEN`          | The key. TODO(new:adapter) its permissions. |
#end
