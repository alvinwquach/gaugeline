# Content kept in git: content checks for sites whose content lives in the repo

What a site's content files say is published, against what the live site shows. Gaugeline only reads: a folder on your computer, or a repository on GitHub with a token that can read file contents and nothing else.

**The key first.** A folder on your computer needs no key at all. Reading from GitHub works without one for a public repository, and for a private one it takes a fine-grained token with a single permission, **Contents: read**, on that one repository. That token can read the repository's files and cannot change anything in it. It goes in `GAUGELINE_GITHUB_TOKEN` (the same variable [renewals](/docs/guides/renewals) use, so one read-only token does for both), is sent in an `Authorization` header to `api.github.com` only, and never reaches a log, a finding or a report. Its key kind in the run header is `read-only`.

This page lists what the adapter reads, how each static site generator's address pattern is written, a worked example for a freelancer's clients, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** The GitHub REST API's own pages and the generators' routing documentation were not read while this page was written. The two GitHub endpoints, their answer shapes and the permission name are from the build's knowledge of the API and are marked [docs] with the page to confirm them against; the address patterns follow each generator's documented defaults and are what the tests check. If a page here disagrees with the generator's own documentation, the generator is right and the pattern in your settings is the fix.

## Who this is for

Sites whose pages are built from files in the repository: Astro content collections, Hugo, Jekyll, Eleventy, Nuxt Content, and the editors that write those files (Decap CMS, Keystatic, Front Matter, TinaCMS in its git mode). Markdown and MDX with front matter, and JSON and YAML files, in the folders you name. A site whose content is in a database or a hosted CMS has its own adapter.

## What it reads

There are two sources, and you give exactly one in `gaugeline.adapters.json`.

**`path`**: a folder on your computer, relative to where you run Gaugeline. Nothing is requested over the network.

- Only the folders listed under `folders` are read, and only inside `path`. A `dir` with `..` or an absolute path is refused when the settings are read.
- A symbolic link is never followed, to a file or to a folder, so a link cannot lead outside the repository. A link is listed as unread with that reason.
- `node_modules`, `.git` and `_drafts` folders are skipped, and so are files whose names start with `_` (Hugo's `_index.md`, files Astro ignores).
- Files are read whole only up to the bound below, and a front matter block is parsed with the `yaml` library with a limit on aliases.

**`github`**: a repository, with an optional `ref` (a branch, tag or commit; the default branch when left out). Every request is a `GET` to `https://api.github.com` through the same fetcher as every other request.

| Endpoint                                                | Permission     | What for                                                                                                           |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` | Contents: read | The list of files and their sizes, once. [docs] https://docs.github.com/en/rest/git/trees#get-a-tree               |
| `GET /repos/{owner}/{repo}/git/blobs/{sha}`             | Contents: read | One content file, as base64, to read its front matter. [docs] https://docs.github.com/en/rest/git/blobs#get-a-blob |

Each content file is one request, so a folder is capped much lower on GitHub than on disk (see the bounds). For a big repository, clone it and use `path`. A public repository without a token is limited by GitHub to 60 requests an hour, so a token is worth setting even then. A redirect to another origin is followed without the token, and GitHub's answer is checked before anything is used.

### What reaches your computer

A file has to be read to know whether it is a draft, so the whole file arrives. What is kept is only the front matter fields, and only until they are counted or hashed. The body of a post is thrown away as soon as the front matter is cut from it. Reports show field names and the mismatch, never your client's words.

## How an item becomes a published page

For each file the adapter decides whether it is live, and where it lives.

**Published state**, from the front matter:

| Front matter                                                                     | Meaning                                                    | Used by                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `draft: true`                                                                    | Not published                                              | Hugo, Astro, Eleventy, Nuxt Content, Decap, Keystatic |
| `published: false`                                                               | Not published                                              | Jekyll                                                |
| `permalink: false`                                                               | Not written to the site at all                             | Eleventy                                              |
| `publishDate`, `publishedAt`, `pubDate`, `datePublished` or `date` in the future | Scheduled, not live yet (the first of these that is there) | Hugo, Jekyll, Astro                                   |
| `expiryDate`, `expirydate` or `unpublishDate` in the past                        | Expired, no longer live                                    | Hugo                                                  |

The run's clock decides "future" and "past". A file with none of these is published. A date with no time zone is read as UTC.

**Dates** are the front matter's: `publishedAt` is the first of `publishDate`, `publishedAt`, `pubDate`, `datePublished`, `date`, and `updatedAt` is the first of `lastmod`, `updatedDate`, `updatedAt`, `updated`, `dateModified`, `modified`, `lastUpdated`, or else the published date. A file's modification time is never used: a checkout sets it to the time of the checkout, so it says nothing about the content. An item with no date has none, and a `since` filter keeps it, because it cannot be shown to be older.

**Address**, from the folder's `permalink` pattern, or from the file's own front matter when it gives a plain address (Hugo's `url`, Jekyll's and Eleventy's `permalink`). An address that is a template (`{{ ... }}`) cannot be run without the generator, so the folder's pattern is used for it. Nothing is made up: an item that lacks a value its pattern needs gets no address, and its page is not checked.

A token is written `{slug}` or, as Hugo and Jekyll write it, `:slug`.

| Token            | Value                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `slug`           | the `slug` field, or the file name without its extension and any `YYYY-MM-DD-` prefix                                             |
| `slugorfilename` | the same as `slug` (Hugo's name for it)                                                                                           |
| `id`             | the file's path from the repository root, with its extension                                                                      |
| `path`           | the file's path inside its folder without the extension (Astro's entry id, Nuxt Content's route); `index` files give their folder |
| `nuxt_path`      | `path` with Nuxt Content's ordering prefixes (`1.`) dropped from each part                                                        |
| `filename`       | the file name without its extension (Hugo's `:filename`)                                                                          |
| `title`          | the file name without its extension and `YYYY-MM-DD-` prefix (Jekyll's `:title`)                                                  |
| `section`        | the last part of the folder's `dir` (Hugo's section)                                                                              |
| `year`           | four digits, from the file name's date (Jekyll) or else the publish date                                                          |
| `month`          | two digits, as `year`                                                                                                             |
| `day`            | two digits, as `year`                                                                                                             |
| `categories`     | the `categories` or `category` field, joined with `/` (Jekyll); empty when there are none                                         |
| `output_ext`     | `.html` (Jekyll's `date` style)                                                                                                   |

Jekyll's built-in styles can be named instead of a pattern: `date` is `/:categories/:year/:month/:day/:title:output_ext`, `pretty` is `/:categories/:year/:month/:day/:title/` and `none` is `/:categories/:title:output_ext`.

| Generator                      | Folder and pattern to start from                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Astro                          | `dir: src/content/blog`, `permalink: /blog/{slug}/` (or `{path}` for the entry id) |
| Hugo                           | `dir: content/posts`, `permalink: /:section/:slugorfilename/`                      |
| Jekyll                         | `dir: _posts`, `permalink: pretty` or your `permalink:` from `_config.yml`         |
| Eleventy                       | `dir: src/posts`, `permalink: /posts/{filename}/` unless the file sets `permalink` |
| Nuxt Content                   | `dir: content/blog`, `permalink: /blog/{nuxt_path}`                                |
| Decap, Keystatic, Front Matter | the folder the editor writes to, and the pattern of the generator under it         |

Two differences to know about. Hugo's `:slug` is the title when there is no `slug` field, and Gaugeline uses the file name instead; set `slug` in the front matter, or expect a mismatch to be reported as a page that is not there. Nuxt Content's `index` files and numbered prefixes are handled by `{nuxt_path}`; a file whose name starts with a number and a dot, followed by a letter, loses that prefix there.

### Files it could not read

A file that is there and cannot be read is not a page that is missing. A front matter block that is not valid YAML, TOML front matter (`+++`, which is not read yet), a file over the size bound, a link, a front matter that is not closed: each is listed by the adapter's `unread()` with the path and a reason that never quotes the file. A caller shows them as could-not-check. They are never in the published list, and never counted as pages that are gone.

## Example: a pop-up shop on Astro

Nettle & Thread is an invented pop-up shop. A freelancer built its site with Astro content collections: a blog, and stalls kept as YAML files. The owner edits the Markdown in the repository through a Git-based editor. The freelancer wants to know which posts changed lately, and that the draft she saved last week is not live.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "git-content",
      "path": ".",
      "folders": {
        "blog": { "dir": "src/content/blog", "permalink": "/blog/{slug}/" },
        "stalls": { "dir": "src/content/stalls", "permalink": "/stalls/{path}" }
      },
      "fingerprint": { "blog": ["title", "description"] }
    }
  ]
}
```

This is what the adapter reads over her repository (invented: five posts, of which one is a draft and one is scheduled for a date far ahead, so three are live; and a stall file per stall):

```json title=Output
{
  "types": [
    {
      "name": "blog",
      "count": 3
    },
    {
      "name": "stalls",
      "count": 2
    }
  ],
  "blog fields": {
    "title": 3,
    "description": 2,
    "subtitle": 0
  },
  "published posts": [
    {
      "id": "src/content/blog/second-hand-swap.mdx",
      "type": "blog",
      "url": "/blog/swap/",
      "slug": "swap",
      "publishedAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-15T10:00:00.000Z",
      "fieldHashes": {
        "title": "17e6277d004c664d",
        "description": "b6d109a9ed658cef"
      }
    },
    {
      "id": "src/content/blog/spring-market.md",
      "type": "blog",
      "url": "/blog/spring-market/",
      "slug": "spring-market",
      "publishedAt": "2026-03-01T00:00:00.000Z",
      "updatedAt": "2026-03-10T09:30:00.000Z",
      "fieldHashes": {
        "title": "dcd4e45c4dbedf82",
        "description": "94ccf16d2e93627c"
      }
    },
    {
      "id": "src/content/blog/workshop-dates.md",
      "type": "blog",
      "url": "/blog/workshop-dates/",
      "slug": "workshop-dates",
      "publishedAt": "2026-02-01T00:00:00.000Z",
      "updatedAt": "2026-02-01T00:00:00.000Z",
      "fieldHashes": {
        "title": "f24e63103de594e8"
      }
    }
  ],
  "unread": {
    "total": 0,
    "files": []
  }
}
```

Read it the way the freelancer does. Three posts are live and two files are not counted, so a page for the draft would be a surprise. "Workshop dates" has no `description`, so the adapter hashed only its title. The hashes are what a later run compares: when the owner edits a title, that hash changes and the others do not. Where a post sets its own `slug`, the address uses it.

## Example: a cocktail bar on Hugo

The Copper Lantern is an invented bar whose site is built with Hugo. The folder holds a draft, a post scheduled for the end of December, an offer that expired on 1 November, a page bundle, and two files the adapter cannot read: one with TOML front matter and one whose YAML is broken.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "git-content",
      "path": ".",
      "folders": { "posts": { "dir": "content/posts", "permalink": "/:section/:slugorfilename/" } }
    }
  ]
}
```

```json title=Output
{
  "types": [
    {
      "name": "posts",
      "count": 2
    }
  ],
  "published posts": [
    {
      "id": "content/posts/autumn-menu.md",
      "url": "/posts/autumn-drinks/"
    },
    {
      "id": "content/posts/jazz-night/index.md",
      "url": "/posts/jazz-night/"
    }
  ],
  "unread": {
    "total": 2,
    "files": [
      {
        "path": "content/posts/broken.md",
        "reason": "front matter is not valid YAML (BAD_INDENT) at line 3"
      },
      {
        "path": "content/posts/toml-post.md",
        "reason": "has TOML front matter (+++), which is not read yet"
      }
    ]
  }
}
```

Two posts are live. The two files that could not be read are named with a reason and are not counted, so the broken one is not mistaken for a page that is missing.

## What cannot be checked

- **Drafts reachable**: not applicable. A draft is a file in the same folder, not a place a key can or cannot reach.
- **Members**: a repository's collaborators are not listed by this adapter.
- **Fields of a file that cannot be read**: TOML front matter, invalid YAML, an oversized file, a link.
- **Templates in front matter**: a `permalink` written with `{{ ... }}` needs the generator to run it.
- **Generator settings outside the front matter**: a site-wide permalink in `_config.yml` or `hugo.toml` is not read. Put the pattern in the folder's `permalink`.

## When it cannot check

The adapter says it could not check, with the reason, and never reports a pass, when:

- the `path` or a `dir` does not exist, or a `dir` leads outside the repository through a link;
- a folder has more files than the bound;
- for GitHub: the repository or branch is not found, or is private and `GAUGELINE_GITHUB_TOKEN` is not set or cannot read it (HTTP 404); the token is not accepted (HTTP 401) or lacks Contents: read (HTTP 403); GitHub cut the file list short because the repository is too large; or an answer is not the shape GitHub sends.

A host that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                        | Value |
| -------------------------------------------- | ----- |
| Content files read from one folder on disk   | 5,000 |
| Content files read from one folder on GitHub | 300   |
| Size of one file                             | 1 MiB |
| Folders deep under a content folder          | 12    |

There are no flags to raise them. A file over the size bound is listed as unread; a folder over the file bound is could-not-check, never a count of part of it.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `git-content`.                                                                                                                                                       |
| `adapters[].path`               | A folder on your computer, relative to where you run Gaugeline. Exactly one of `path` and `github`.                                                                  |
| `adapters[].github`             | `{ "repo": "owner/name", "ref": "main" }`. `ref` is optional.                                                                                                        |
| `adapters[].folders`            | The content folders, by type: `{ "blog": { "dir": "src/content/blog", "permalink": "/blog/{slug}/" } }`. `permalink` is optional; without it an item has no address. |
| `adapters[].fingerprint`        | Fields to hash, by type, as names or names joined by dots (`seo.title`). Hyphens are allowed here. Up to 20 per type.                                                |

## Run only on repositories you may read

Gaugeline reads files; it never writes, commits, opens a pull request or sends anything to the repository's owner. A token you give it should be able to do no more.
