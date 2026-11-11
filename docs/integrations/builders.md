# Hosted builders: content checks for sites built on Squarespace and similar builders

What a Squarespace, Duda, Tilda, GoDaddy Website Builder, Weebly, Carrd or Strikingly site publishes, read from the files the live site hands every visitor. No key, and nothing is written. This page says plainly which content checks cannot run on these platforms, and why.

**The key first.** None. These adapters ask for no key, send no `Authorization` header and no cookie, and never log in. A run says so before anything else it prints about the content system:

```text title=Output
Content system: Squarespace, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/builders#squarespace
```

See [Content systems](/docs/integrations/) for the interface every adapter shares.

## One adapter per platform, built from one module

Each platform has its own adapter id (`squarespace`, `duda`, `tilda`, `godaddy`, `weebly`, `carrd`, `strikingly`), all made by the same code. They read the same files and give the same answers; what differs is the name in the run header and the reason each one gives for what it cannot check. That was chosen over one `builders` id with a setting that names the platform, so the id in `gaugeline.adapters.json` and the line in a report say which platform was read, and each platform's reason is in its own words. Adding a platform later is one entry in a table.

## A note on sources

The developer pages of these platforms could not be reached when this page was written (the build session's network policy refused them), and Gaugeline's documentation source was not connected. Everything this page says about what a platform's API offers, and every detection hint below, is **uncited**: written from what the platforms are generally known to offer, and not confirmed against their current documentation. Check a platform's own developer pages before relying on a detail. The rule that holds whatever they say: Gaugeline sends `GET` and `HEAD` and nothing else, never reads an admin screen, and asks for no key it cannot confirm is read-only. If a platform adds a read-only content API, its adapter gains the read, and this page changes with it.

## What it reads

Every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request. The platform's own servers are never asked.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads.
- The feeds the home page advertises; with none advertised, `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml` and `/feed.json`. A builder site has a feed only when its blog or the owner turns one on.

It reads them the way the [Sitemap and feeds](/docs/integrations/sitemap-feed) adapter does, and that page has the limits, the dates and the safety rules, which are the same here: only an address and its dates are kept, a title or a word of the client's text never is, and a sitemap that is missing, refused or unreadable is could-not-check, never an empty list. It never asks for a page of the site: whether an address in the sitemap still answers is the job of the sitemap checks, not of an adapter.

## What cannot run, and why

The content checks that compare a content system with the live page need the content system's side. A hosted builder with no read-only content API gives Gaugeline only the live side, so these parts are could-not-check with the reason, on every platform here:

| Question                                         | Answer here                            | Why                                                                                                                     |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Drafts and unpublished pages (`draftsReachable`) | `not-applicable`, with no request made | Unpublished work lives in the builder's editor, not on the site. Gaugeline does not look in the editor.                 |
| How many items have each field (`fieldCounts`)   | could not check, "Not applicable"      | A page or blog post has no fields Gaugeline can read: the platform offers no read-only content API (see each platform). |
| A hash of a field's value (`fieldHashes`)        | always empty                           | There is no field to hash. The settings' `fingerprint` is refused for these adapters.                                   |
| Members and who has access (`members`)           | not offered                            | No public file lists people, and an account's people are behind its login.                                              |
| CMS items against live pages (drift)             | not checked                            | It needs the CMS side. The sitemap checks cover the live side.                                                          |

Nothing is scraped from an admin screen to fill the gap, and no login is attempted. A platform whose editor is the only place the content exists has no read Gaugeline is allowed to make.

What does run, with no change, is every check that reads only the live site: the whole default `gaugeline check`, and the sitemap checks (`sitemap-dead`, `sitemap-redirects`, `sitemap-missing`, `sitemap-host`), which are what stand in for "CMS items against live pages" on these platforms. The adapter's own answer is: which addresses the live site says are published, and when they changed.

## Example: a pop-up shop on Squarespace

Tidewater Pop-Up is an invented weekend pop-up that sells sea-glass jewellery at harbour markets. A freelancer built its site on Squarespace: a few pages (home, about, visit), a small shop with one page per piece, and a blog the owner writes from her phone on market mornings. The freelancer wants to know which pages the site says changed lately, before the next market.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address. There is nothing to put in the environment:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "squarespace",
      "site": "https://tidewater-popup.example"
    }
  ]
}
```

This is what the adapter reads over her site (invented), for pages changed since 1 November:

```json title=Output
{
  "types": [
    {
      "name": "blog",
      "count": 1
    },
    {
      "name": "shop",
      "count": 2
    },
    {
      "name": "top-level",
      "count": 3
    }
  ],
  "field counts": "could not check: Not applicable to what Gaugeline can read from a Squarespace site. Gaugeline has not confirmed a read-only content API for Squarespace's pages and blog posts (its developer APIs cover the store, which is products, orders, inventory and profiles, and not pages or blog posts; store access is a separate adapter), and it never reads a site's admin screens. Its fields, drafts and members are therefore not read. What the live site publishes is read from its sitemap instead.",
  "drafts reachable": "not-applicable",
  "changed since 1 November": [
    {
      "id": "https://tidewater-popup.example/",
      "type": "top-level",
      "url": "https://tidewater-popup.example/",
      "updatedAt": "2026-11-03T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://tidewater-popup.example/visit",
      "type": "top-level",
      "url": "https://tidewater-popup.example/visit",
      "slug": "visit",
      "updatedAt": "2026-11-08T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://tidewater-popup.example/shop/sea-glass-pendant",
      "type": "shop",
      "url": "https://tidewater-popup.example/shop/sea-glass-pendant",
      "slug": "sea-glass-pendant",
      "updatedAt": "2026-11-09T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://tidewater-popup.example/blog/harbour-stall",
      "type": "blog",
      "url": "https://tidewater-popup.example/blog/harbour-stall",
      "slug": "harbour-stall",
      "updatedAt": "2026-11-06T00:00:00.000Z",
      "fieldHashes": {}
    }
  ]
}
```

Read it the way the freelancer does:

- The sea-glass pendant page changed on 9 November, two days before the market. It is on the sitemap, so the site says it is published. Whether the editor agrees (a page saved and never published, a product hidden) is what this adapter cannot see.
- The driftwood studs page (12 October) and the About page (14 September) are left out: their dates are older. Their addresses are in the `shop` and `top-level` counts all the same.
- Field counts are could-not-check, with the reason, and every `fieldHashes` is empty. The pages' titles and prices are in the pages and never in the output.
- Drafts are `not-applicable`: the sitemap lists only what is published.

## A hint, not a decision: which builder is this?

When you are handed a client's page you may want to know which adapter to name. `suggestBuilder` (exported from the core package) looks at a page's own markup, with no request, and returns the adapter id it points to:

```json title=Hint
{
  "id": "squarespace",
  "name": "Squarespace",
  "evidence": "generator tag"
}
```

It looks at two things only: the `generator` meta tag, and the host names of the page's scripts, stylesheets, icons and images. A link to a builder's own website, a word in the page's text and a canonical link are never signs. The same markup always gives the same answer. **Detection is a hint.** It is used to suggest an `adapters` entry (`gaugeline init` will use it once it exists) and for these docs; it never switches an adapter on, a run uses exactly the adapters it was given, and a site on a custom setup, behind a proxy or built before the hint was written can show nothing or a wrong sign. The hints are uncited (see the note on sources), and a wrong or missing one only means a suggestion that is not made.

## Platform by platform

Each section gives the adapter id, what a hint looks for, and the reason Gaugeline does not read the platform's content beyond the live site.

### Squarespace

- Adapter id: `squarespace`. Pages and blogs are read from the sitemap, and from the blog's feed when the home page advertises one.
- Hints: `static1.squarespace.com`, `images.squarespace-cdn.com`, `assets.squarespace.com`, and a generator tag that starts with `squarespace`.
- Why no content read: its developer APIs cover the store, which is products, orders, inventory and profiles, and not pages or blog posts; store access is a separate adapter.

### Duda

- Adapter id: `duda`.
- Hints: `irp.cdn-website.com`, `lirp.cdn-website.com`, `multiscreensite.com`.
- Why no content read: its API is for agencies and partners and its credentials can also change sites, so it is not a read-only key.

### Tilda

- Adapter id: `tilda`.
- Hints: `static.tildacdn.com`, `tildacdn.com`, `tildacdn.net`.
- Why no content read: it has an export API for a project's pages, and Gaugeline has not confirmed that its key pair is read-only.

### GoDaddy Website Builder

- Adapter id: `godaddy`.
- Hints: `img1.wsimg.com`, `wsimg.com`, and a generator tag that starts with `go daddy website builder`.
- Why no content read: Gaugeline knows of no public API that reads a site's pages.

### Weebly

- Adapter id: `weebly`.
- Hints: `editmysite.com`, `weebly.com`.
- Why no content read: Gaugeline knows of no public API that reads a site's pages or blog posts.

### Carrd

- Adapter id: `carrd`.
- Hints: `carrd.co`.
- Why no content read: Gaugeline knows of no public API that reads a site's content.

### Strikingly

- Adapter id: `strikingly`.
- Hints: `strikinglycdn.com`, `mystrikingly.com`.
- Why no content read: Gaugeline knows of no public API that reads a site's pages or blog posts.

A platform with a read-only content API, such as Webflow, has its own adapter and its own page. A single-page builder such as Carrd has little to list: its sitemap, if it has one, names the one page.

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when no sitemap and no feed could be read (it names where it looked), the site answers with a login (HTTP 401 or 403), a sitemap that `robots.txt` or your settings name is missing or is not a sitemap, a file is larger than the cap, or the run has no site address. A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial. A site with neither a sitemap nor a feed gets the live-site checks alone.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | The platform's id from the sections above.                                                                                                         |
| `adapters[].site`               | The site's address (`https://tidewater-popup.example`). Wins over the address the run was given.                                                   |
| `adapters[].sitemaps`           | Up to 10 sitemap files to read instead of looking: a path on the site or an https address on it. Each must answer, or the read is could-not-check. |
| `adapters[].feeds`              | Up to 5 feeds to read instead of looking, likewise.                                                                                                |

`fingerprint` and `urls` are refused for these adapters: they have no fields to hash, and an item is its own address.
