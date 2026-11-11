# TinaCMS: content checks for sites built on TinaCMS

What a TinaCMS site's content files say is published, against what the live site shows. Gaugeline only reads: the folder on your computer, or the repository on GitHub, where TinaCMS keeps the content. It asks for no TinaCMS key and never uses the TinaCloud token.

## What this adapter reads, and the narrowest key

**The key first.** TinaCMS saves what editors write as Markdown, MDX, JSON or YAML files in your Git repository, and `tina/config.ts` says which folders are collections. So this adapter reads the repository, not a TinaCMS API, and asks for no TinaCMS key at all. A folder on your computer needs no key. A private repository on GitHub takes a fine-grained token with one permission, **Contents: read**, on that one repository; it goes in `GAUGELINE_GITHUB_TOKEN` (the variable the [git-content adapter](/docs/integrations/git-content) and [renewals](/docs/guides/renewals) use), travels in an `Authorization` header to `api.github.com` only, and never reaches a log, a finding or a report. The key kind in the run header is `read-only`. The TinaCloud client token (`TINA_TOKEN`) is never read, sent or stored.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. The TinaCMS documentation (tina.io: the collections reference, `ui.router`, the GraphQL content API) could not be reached while this page was written, so the property names the adapter reads from `tina/config.ts` (`name`, `path`, `format`, `match`, `ui.router`, `clientId`), the file formats and the content API's request method are from the build's knowledge of TinaCMS, marked [docs] with the page to confirm them against and `uncited` until someone has. The GitHub endpoints and permission are the ones on the [git-content page](/docs/integrations/git-content). If a page here disagrees with TinaCMS's own documentation, TinaCMS is right and the adapter's reading is the bug. [docs]

## What it reads

1. **`tina/config.ts`** (or `.tsx`, `.js`, `.jsx`), at the top of the folder you point `path` at, or of the GitHub repository. It is read **as text and never run**: Gaugeline splits it into strings, names and brackets and reads the `collections: [ ... ]` list from them, so nothing in it (an import, a function call, a `process.env` read) is ever executed. From each collection written out in the file it takes `name` (the content type in reports), `path` (the folder), `format` (`md` when left out; `md`, `markdown`, `mdx`, `json`, `yaml` or `yml`), `match.include` and `match.exclude` (patterns with `*`, `**`, `?` and `{a,b}`, over the path without its extension), and `ui.router` (see below).

   A pattern is matched a folder at a time: `**` crosses folders when it is a whole folder name (`posts/**`, `**/draft-*`), `{a,b}` may expand to at most 32 patterns, and a path over 1,000 characters matches nothing, so no pattern can make a run slow. A collection is not read, and is named with a fixed reason, when it repeats a property (JavaScript takes the last one, so a reader must not guess), has a `format` of `toml` (Gaugeline has no TOML reader) or any value it cannot be sure of. The `collections` list is read only when it is the one plain list in the file and nothing follows its closing bracket but a comma or the end of the object: `collections: [...].filter(...)` is not read, because it is not the list the file shows.

2. **The collection's files**, through the same source, parser and address code as the [git-content adapter](/docs/integrations/git-content): a folder on your computer (no request is made; links are never followed; hidden files are skipped) or a repository on GitHub (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` once, and `GET /repos/{owner}/{repo}/git/blobs/{sha}` for each file). Only files with the collection's `format` extension that `match` allows are items.

A file is published unless its front matter says otherwise: `draft: true` (the usual Tina boolean field for it; **uncited**, the TinaCMS documentation could not be reached), or a `publishDate`, `pubDate`, `date` and the like in the future. The git-content page lists them all. A date with no time zone is read as UTC. Files whose name starts with an underscore (`_notes.md`) or a dot are not content: the git-content reader skips them, so they are not counted.

**Addresses.** TinaCMS gives a collection's pages their address in `ui.router`, a function. Gaugeline never runs it; it reads it only when it is one arrow function that returns one template, built from these three values: `document._sys.filename` (the file name without its extension), `document._sys.breadcrumbs.join("/")` (the path inside the folder) and `document.slug` (a field named `slug`). So `` ({ document }) => `/news/${document._sys.filename}` `` gives `/news/sourdough-class`. A router that does anything else (a condition, a lookup, a helper) leaves that collection's items with no address, and the adapter says so; name the address in the settings instead (`folders`, below).

### TinaCloud

If `tina/config.ts` has a `clientId`, the site uses TinaCloud, which keeps an index of the same Git content and serves it through a GraphQL API. Gaugeline does not read that API: it answers queries with a POST (documented read-only queries may only go through the allowlist in [ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md), and TinaCMS's documentation could not be reached to write one), and it needs the TinaCloud client token. Everything the checks need is in the repository, so the adapter reports "TinaCloud is configured, but its content API is not read" as a could-not-check line and carries on with the files. This is a choice that can be reversed: a TinaCloud read, through ADR-0006, would be its own branch.

### What reaches your computer

A file has to be read to know whether it is a draft, so the whole file arrives. What is kept is only the front matter fields, and only until they are counted or hashed. The body is thrown away as soon as the front matter is cut from it. With no `fingerprint` in the settings nothing is hashed at all, and reports show field names and the mismatch, never your client's words. The content of `tina/config.ts` is never quoted either: the lines that say a collection could not be read are fixed sentences.

## Example: a bakery on Next.js and TinaCMS

Rye & Ember Bakery is an invented neighbourhood bakery. A freelancer built its site with Next.js and TinaCMS: news posts, the breads on the menu, and two pages (home and opening hours) kept as JSON. The owner edits them from her phone, between batches. The freelancer wants to know that the draft Christmas order form she saved is not live, that the retired spelt loaf is gone from the menu, and which pages Gaugeline should compare with the live site.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "tina",
      "path": ".",
      "fingerprint": { "post": ["title", "summary"] }
    }
  ]
}
```

The invented repository has three collections in `tina/config.ts`: `post` (`content/posts`, MDX, address `/news/{file name}`), `bread` (`content/bread`, Markdown, address from each loaf's `slug` field, a `retired` folder left out by `match`) and `page` (`content/pages`, JSON, only `home` and `hours`). Three posts exist, one a draft. This is what the adapter reads (the `TinaCloud` line is there because the config names a client):

```json title=Output
{
  "types": [
    {
      "name": "bread",
      "count": 2
    },
    {
      "name": "page",
      "count": 2
    },
    {
      "name": "post",
      "count": 2
    }
  ],
  "post fields": {
    "title": 2,
    "summary": 1,
    "subtitle": 0
  },
  "published items": [
    {
      "type": "bread",
      "id": "content/bread/cardamom-bun.md",
      "url": "/bread/cardamom-bun"
    },
    {
      "type": "bread",
      "id": "content/bread/dark-rye.md",
      "url": "/bread/rye"
    },
    {
      "type": "page",
      "id": "content/pages/home.json",
      "url": "/home"
    },
    {
      "type": "page",
      "id": "content/pages/hours.json",
      "url": "/hours"
    },
    {
      "type": "post",
      "id": "content/posts/saturday-hours.mdx",
      "url": "/news/saturday-hours",
      "fieldHashes": {
        "title": "741f499e07886ea4"
      }
    },
    {
      "type": "post",
      "id": "content/posts/sourdough-class.mdx",
      "url": "/news/sourdough-class",
      "fieldHashes": {
        "title": "892f33369b2ead83",
        "summary": "9633eca336b26319"
      }
    }
  ],
  "not read": [
    {
      "name": "TinaCloud",
      "reason": "TinaCloud is configured, but its content API is not read: this adapter reads the content files in the repository, which TinaCloud indexes from git, and does not use the TinaCloud client token.",
      "kind": "tinacloud"
    }
  ],
  "drafts reachable": "not-applicable"
}
```

How the freelancer reads it. Each collection came from `tina/config.ts` with the same count the editor shows: two posts (the draft is not live), two loaves (the retired one is excluded by `match`), two pages. The dark rye has the address `/bread/rye` because its `slug` field says so; the file name is `dark-rye`. Those addresses are the pages Gaugeline compares with the live site, and the hashes are what it compares: a title that changed in the repository but not on the site is a finding, and the report shows the field name, never the words. The one `not read` line is TinaCloud, which is not read (above).

## What cannot be checked

Anything the repository does not hold is could-not-check, with the reason, never a pass and never scraped from TinaCMS's admin screens:

| Question                               | Answer here      | Why                                                                                                                      |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Drafts reachable                       | not applicable   | A draft is a file with `draft: true` in the same folder, not a place a key can or cannot reach.                          |
| Who has access to the site (`members`) | not offered      | Editors and their roles live in TinaCloud or in the Git host, and are not read.                                          |
| TinaCloud's content API                | not read         | See above: a POST and a client token, neither of which this adapter uses.                                                |
| A collection defined in another file   | not read         | `collections: [postCollection]` needs the import followed, which means running the config. Name its folder in `folders`. |
| An address from a clever `ui.router`   | no address       | Only a single template of the three values above is read.                                                                |
| Whether a page shows the same words    | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                 |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- there is no `tina/config.ts` (or `.tsx`, `.js`, `.jsx`) under `path` or in the repository, and no `folders` are named by hand;
- the config is too large, is a link, or has no `collections: [ ... ]` list written out in it, and no `folders` are named by hand. Collections that are written out are read, and the ones that are not are listed under "not read";
- a collection's `path` is not a plain folder (a `..`, an absolute path, a hidden or `node_modules` folder, a variable) or does not exist, or a folder has more files than the git-content bound;
- for GitHub: the repository or branch is not found or is private and `GAUGELINE_GITHUB_TOKEN` is not set (HTTP 404), the token is not accepted (HTTP 401) or lacks Contents: read (HTTP 403), or GitHub cut the file list short.

A host that asks Gaugeline to slow down (HTTP 429, or 403 with `x-ratelimit-remaining: 0`) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                        | Value   |
| -------------------------------------------- | ------- |
| Size of `tina/config.ts`                     | 512 KiB |
| Collections in the config                    | 200     |
| Content files read from one folder on disk   | 5,000   |
| Content files read from one folder on GitHub | 300     |
| Content files read from GitHub with no token | 50      |
| Size of one content file                     | 1 MiB   |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `tina`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `adapters[].path`               | The project folder on your computer (the one that holds `tina/`), relative to where you run Gaugeline. Exactly one of `path` and `github`.                                                                                                                                                                                                                                                  |
| `adapters[].github`             | `{ "repo": "owner/name", "ref": "main" }`. `ref` is optional.                                                                                                                                                                                                                                                                                                                               |
| `adapters[].folders`            | Optional. Collections named by hand, as for git-content: `{ "post": { "dir": "content/posts", "permalink": "/news/{filename}" } }`. A name that is also in the config replaces its folder and address, and keeps the config's `format` and `match` when the folder is the same. A name that is not in the config is read as a plain folder, and stands in for a config that cannot be read. |
| `adapters[].fingerprint`        | Fields to hash, by collection name. Up to 20 per collection.                                                                                                                                                                                                                                                                                                                                |

## Run only on repositories you may read

Gaugeline reads files; it never writes, commits, opens a pull request or sends anything to the repository's owner or to TinaCloud. A token you give it should be able to do no more.
