# How it works

Why websites break in ways the editor can't see, and where Gaugeline looks.

## Four ways websites get built

| Kind                  | How editing works                                                         | The gap                                      |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| Wix, Squarespace      | You edit the page itself                                                  | Almost none                                  |
| WordPress             | You write in a dashboard; a theme on the same server turns it into pages  | Small. The preview is close to the real page |
| Webflow               | Designers lay out pages; your team fills in collections                   | Small. You see real pages while editing      |
| Headless, like Sanity | You type into an editor; a separate website built by a developer shows it | Wide. The editor can't see the finished page |

- **If you own the site:** The short version: the place you type is not the place visitors read. Gaugeline checks the second one.
- **If you run marketing:** Your campaign lands on the built page, not the draft, which is why a fine-looking edit can still lose you a ranking.
- **If you edit content:** Preview shows your draft. Gaugeline shows what everyone else gets.
- **If you build the site:** Content is fetched at build or request time; a valid document can still produce an invalid page.

## What a check reads

1. The page's HTML, exactly as a crawler receives it, without running JavaScript.
2. Every redirect on the way to that page.
3. robots.txt and the sitemap.
4. Up to 30 same-site links and 12 addresses inside structured data.
5. Up to 15 same-site JavaScript files, looking for private keys.
6. If the page uses Sanity images, whether the dataset is public, and the names of its content types.

::: info
Checks are plain rules, not AI. The same site gets the same answer every time. See [Privacy and safety](/docs/privacy) for exactly what's read.
:::

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

### What a check reads

Gaugeline asks for the page the way a crawler does, without running any JavaScript, and parses the
HTML once into a _snapshot_. Every page check reads that snapshot:

| Field                                                    | What it holds                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `requestedUrl`, `finalUrl`, `status`, `hops`             | The address asked for, where it ended up, and every redirect on the way                    |
| `title`, `canonical` (and every canonical), `metaRobots` | The head tags search engines read                                                          |
| `headings`                                               | `h1` to `h3`, with their text and id                                                       |
| `links`, `images`, `scripts`                             | Resolved against the page (and its `<base href>`); links say whether they stay on the site |
| `jsonLd`, `jsonLdErrors`                                 | Structured data blocks, and any that are not valid JSON                                    |
| `og`                                                     | Share-preview tags (`og:title`, `og:image`, ...)                                           |
| `forms`                                                  | Each form's action, method and hidden field names                                          |
| `ids`                                                    | Every element id on the page, for `#anchor` links                                          |
| `wordCount`                                              | Words a visitor sees before JavaScript runs                                                |

Two details matter to the checks:

- An image with `alt=""` (decorative on purpose) and an image with no `alt` at all are recorded
  differently, because they are two different findings.
- Text is read the way a person sees it: script, style, `noscript`, `template` and hidden elements
  do not count towards `wordCount`. A page that only fills itself in with JavaScript has a word count
  near zero, which is exactly what the thin-HTML check reports.

### Stega characters

Sanity's visual editing can hide invisible "stega" characters inside text. Gaugeline strips them
before comparing text and records that it found them.

### Character sets

The body is decoded with the charset in the `Content-Type` header, or a `<meta charset>` near the
top of the page when the header has none, or UTF-8.
