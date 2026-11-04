# How it works

## What a check reads

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

## Stega characters

Sanity's visual editing can hide invisible "stega" characters inside text. Gaugeline strips them
before comparing text and records that it found them.

## Character sets

The body is decoded with the charset in the `Content-Type` header, or a `<meta charset>` near the
top of the page when the header has none, or UTF-8.
