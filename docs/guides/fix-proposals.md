# Fix proposals: a diff for what lives in your code

Finding the problem is half the job. Some findings live in a file you own: a redirect the launch plan
promised and the redirect file never got, a phone number in the structured data that is not the one on the
page. `gaugeline propose` turns those findings into **proposals**: the exact change as a diff, the finding
it answers, the file it changes and how the change is checked again. You read the diff like any other.

**It changes nothing and sends nothing.** `propose` reads your project's folder, asks the preview you name
for the old addresses (`GET` only, like every check), prints each diff and writes the proposals to a file.
It never edits a file in your project, never talks to GitHub and never opens a pull request. Fix proposals
are also **off by default**: without `--fixes` (or `GAUGELINE_FIXES=1`) the command stops before it reads
anything.

## An example: a bookshop's missing redirects

Lantern Books is moving to a new site. The launch plan says `/old-poetry` and `/old-kids` move to `/poetry`
and `/kids`; the project's `public/_redirects` file has rules for the fiction pages only.

```text title="Terminal" untested="Needs a project folder and a preview. packages/cli/src/__tests__/propose-docs.test.ts runs this command in an invented folder against a local stand-in for the preview and compares the output."
$ npx gaugeline propose --fixes --repo . --plan plan.csv --base https://preview.lanternbooks.example
```

```text title="Output"
px_2810a31a355635a1  redirect  Redirect /old-poetry to /poetry
  answers plan-redirect-missing: /old-poetry returns 404: nothing redirects it
  checked again by: Request /old-poetry on the pull request's preview: it must answer 301 to /poetry (gaugeline plan <plan> --base <preview>).

--- a/public/_redirects
+++ b/public/_redirects
@@ -1,3 +1,4 @@
 # Old addresses from the previous site
 /old-fiction	/fiction	301
 /fiction-old	/fiction	301
+/old-poetry	/poetry	301

px_6cdeccd85896e07b  redirect  Redirect /old-kids to /kids
  answers plan-redirect-missing: /old-kids returns 404: nothing redirects it
  checked again by: Request /old-kids on the pull request's preview: it must answer 301 to /kids (gaugeline plan <plan> --base <preview>).

--- a/public/_redirects
+++ b/public/_redirects
@@ -1,3 +1,4 @@
 # Old addresses from the previous site
 /old-fiction	/fiction	301
 /fiction-old	/fiction	301
+/old-kids	/kids	301

2 proposals written to gaugeline.proposals.json. Nothing was sent anywhere.
```

The new rule uses the file's own layout (here a tab between columns). Every proposal is made against the
file as it is now, so two proposals for one file overlap: apply one, then run `propose` again for the next.
The same finding gives the same proposal every time, with the same `px_` id, so a proposal you have already
looked at is easy to recognise.

## A second example: a phone number the page does not show

Cedar Bar's page shows 555 0142 and the owner declared the same number, but the `LocalBusiness` block in
`src/layout.html` still says 555 0100. A run saved with `gaugeline cedarbar.example --json > run.json`
reports it as a `facts-match` finding, and the proposal is one changed line:

```text title="Terminal" untested="Needs a saved run and a project folder. packages/cli/src/__tests__/propose-docs.test.ts runs this command in an invented folder and compares the output."
$ npx gaugeline propose run.json --fixes --repo ./cedar-bar
```

```text title="Output"
px_0bb74bada19bf0c8  structured-data  Correct "+1 555 0100" to "+1 555 0142" in the structured data of /about
  answers facts-match: phone: declared "+1 555 0142", as on /; /about has "+1 555 0100" (structured data)
  checked again by: Run gaugeline on the pull request's preview: the structured data of /about must read "+1 555 0142" and facts-match must not report it.

--- a/src/layout.html
+++ b/src/layout.html
@@ -7,7 +7,7 @@
         "@context": "https://schema.org",
         "@type": "BarOrPub",
         "name": "Cedar Bar",
-        "telephone": "+1 555 0100"
+        "telephone": "+1 555 0142"
       }
     </script>
   </head>

1 proposal written to gaugeline.proposals.json. Nothing was sent anywhere.
```

## A third example: a hero image that loads last

Quillfeather Bakery's page puts a lazy-loading attribute on the picture that is the largest thing on the page, and
asks for it at 3840 pixels for an 800 pixel slot. A run saved with `gaugeline quillfeather.example --json > run.json`
reports it as a `perf-lcp-image` finding (the framework speed causes guide, once it merges), and the same run
reports a 3D scene that starts at load and a missing low-end fallback:

```text title="Terminal" untested="Needs a saved run and a project folder. packages/cli/src/__tests__/propose-docs.test.ts runs this command in an invented folder and compares the output."
$ npx gaugeline propose run.json --fixes --repo ./quillfeather-bakery
```

```text title="Output"
px_59746039ad91c791  performance  Load the first large image /img/loaves.jpg first (no lazy loading)
  answers perf-lcp-image: The first large image, https://quillfeather.example/img/loaves.jpg?w=3840, is lazy-loaded, so the browser waits to fetch it; and is asked for at 3840 pixels wide but shown 800 wide: it is probably what the page's largest paint waits for.
  checked again by: Run gaugeline on the pull request's preview: perf-lcp-image must not report /img/loaves.jpg.

--- a/src/index.html
+++ b/src/index.html
@@ -11,8 +11,7 @@
         src="/img/loaves.jpg?w=3840"
         width="800"
         height="450"
-        loading="lazy"
-        alt="A tray of loaves"
+        alt="A tray of loaves" fetchpriority="high"
       />
       <canvas id="scene" width="1280" height="720"></canvas>
       <p>An invented bakery for Gaugeline's tests.</p>

1 proposal written to gaugeline.proposals.json. Nothing was sent anywhere.
```

One proposal, two attributes on one tag. The other three things in the run get no proposal, and `propose` says why on
stderr: the oversized width comes from the address or the image component's settings, which differ by site; a 3D scene
that starts at load needs a start step or a still picture first, which is a design choice; and a fallback for a small
phone is the same. A person decides those. The assistant tool `draft_fix` ([MCP](../mcp.md)) writes the same
two-attribute change as text for a page it has read, with the one tag on one line.

## The three fixers

| Fixer             | Answers                                        | Reads                                                                                                     | Changes                                                                                         |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `redirect`        | `plan-redirect-missing` (from `--plan --base`) | A Netlify `_redirects` file, or a `vercel.json`                                                           | One added rule: `from`, `to`, `301`                                                             |
| `structured-data` | `facts-match` (from a saved run)               | Pages, templates, scripts and `.json` files that hold JSON-LD (a `ld+json` block or a schema.org context) | One value: the whole value of one JSON-LD property                                              |
| `performance`     | `perf-lcp-image` (from a saved run)            | The project's pages, templates and components with an `<img>` tag                                         | Two attributes of one tag: no `loading="lazy"`, `fetchpriority="high"` (`fetchPriority` in JSX) |

The `performance` fixer finds the image's tag by its **whole** `src` (the same path, written from the site's root or
as an address on the site's own host: a longer path that merely ends the same way, a relative path and another site's
address are different images), and reads the tag one attribute at a time, never with a pattern. It makes a diff only
for a tag made of plain attributes (`name="value"`, `name='value'`, `name=value` or a bare `name`). It leaves a tag
to a person, with the reason and no diff, when the tag has a `{ }` expression or template code, a `<` or `>` inside
an attribute value, an attribute in a framework's own syntax, a `fetchpriority` already (of any value, in any case),
a `loading` that is not plain `lazy`, or when the tag only appears inside a comment, a template literal, a string, a
`<script>`, `<style>`, `<pre>` or `<code>` body or a Markdown code block. It reads the first megabyte of a file.

All three edit the text of the file in place, in its own layout (tabs or spaces, aligned columns, indentation,
the quote style, Windows line endings). A hand-reformatted file is fine; no fixer rewrites a file
from a parsed copy, so the diff is the added or changed line and nothing else.

## When a fixer is not certain, it makes no proposal

A wrong redirect or a wrong number in a pull request is worse than none, so each fixer proposes only what
it can prove from the files. Otherwise it says why on stderr (hidden by `--quiet`) and writes nothing for
that finding:

- **Redirects:** there is no `_redirects` or `vercel.json`, or there is more than one; a line or the JSON
  cannot be read exactly; the old address already has a rule; an earlier pattern (`/old-*`, `/:section`,
  `/(.*)`) may take the address first; the old address has a query string, a wildcard or a character that
  would need escaping; two plan rows claim the same old address; or the old address still answers `200`
  (a rule in a redirect file may not take over from a page that is still served).
- **The first large image:** its `<img>` tag is not found, or is written in more than one place; its `loading` is set
  by an expression or is another value; its fetch priority is already set to something that is not high; the tag
  spreads props into itself; or it is not an `<img>` tag (a component such as `<Image>` is not read). The oversized
  width, a 3D scene that starts at load, an animation that moves layout and a missing low-end fallback always get
  a reason and no diff: each needs a design choice that no patch can make for every site.
- **Structured data:** the wrong value is not written in the project's files, or is written in more than one
  place (the same text is visible copy, or is in a second file: the page may be fed from somewhere else); it
  is not the whole value of a JSON-LD property; or the right value cannot be written exactly inside the
  quotes the file uses.

Everything the files hold is data: a comment in a redirect file or a string in a template is never read as
an instruction.

## Options

| Flag                 | What it does                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `--fixes`            | Turns proposals on. Off by default; `GAUGELINE_FIXES=1` does the same                    |
| `--repo <folder>`    | The project's folder on your computer. Read only                                         |
| `--plan <file>`      | The launch plan (CSV). With `--base`, each old address that does not redirect is checked |
| `--base <address>`   | The preview the plan is checked against                                                  |
| `--to-inbox <file>`  | Also write each proposal as the inbox's pull-request draft (JSON)                        |
| `--repository <o/n>` | The GitHub repository (`owner/name`), written into each proposal. Optional               |
| `--out <file>`       | The proposals file. Default `gaugeline.proposals.json`                                   |
| `--allow-private`    | Allow a preview on this computer or a private network                                    |

The proposals file is versioned (`"version": 1`) and checked when read: a proposal whose id or diff was
changed by hand is refused. `docs/options.md` has the full `--help`.

## Applying a proposal

`propose` only reads. Applying one is a separate, approved step: the proposal becomes a **draft** in
[the hosted inbox](../hosted/inbox.md), a person approves it, and **your own worker** opens a draft pull
request with **your own token** ([applying an approved fix](../hosted/writer.md), ADR-0010). The command
line never opens a pull request, never merges and never holds a write token.

`--to-inbox <file>` writes each proposal as the inbox's `pull_request` draft: a title, a description (the
finding, its evidence, the diff and how it is checked again) and the whole new text of the file. For the
bar's phone number:

```text title="Terminal" untested="Needs a saved run and a project folder. packages/cli/src/__tests__/propose-docs.test.ts runs this command in an invented folder and compares the file."
$ npx gaugeline propose run.json --fixes --repo ./cedar-bar --to-inbox inbox.json
```

It prints `1 inbox draft written to inbox.json. Nothing was sent: a person approves a draft in the inbox
first.` after the diff, and the file holds:

````json title="inbox.json"
{
  "version": 1,
  "drafts": [
    {
      "kind": "pull_request",
      "proposalId": "px_0bb74bada19bf0c8",
      "payload": {
        "title": "Correct \"+1 555 0100\" to \"+1 555 0142\" in the structured data of /about",
        "body": "Gaugeline proposes this change for the finding `facts-match` on https://cedarbar.example/.\n\nEvidence:\n\n```\nphone: declared \"+1 555 0142\", as on /; /about has \"+1 555 0100\" (structured data)\n```\n\nFile: `src/layout.html`\n\nThe change:\n\n```diff\n--- a/src/layout.html\n+++ b/src/layout.html\n@@ -7,7 +7,7 @@\n         \"@context\": \"https://schema.org\",\n         \"@type\": \"BarOrPub\",\n         \"name\": \"Cedar Bar\",\n-        \"telephone\": \"+1 555 0100\"\n+        \"telephone\": \"+1 555 0142\"\n       }\n     </script>\n   </head>\n```\n\nHow it is checked again: Run gaugeline on the pull request's preview: the structured data of /about must read \"+1 555 0142\" and facts-match must not report it.\n\nProposal px_0bb74bada19bf0c8. It is a draft: read the diff, change it if it is wrong, and merge it yourself.",
        "files": [
          {
            "path": "src/layout.html",
            "content": "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <title>Cedar Bar</title>\n    <script type=\"application/ld+json\">\n      {\n        \"@context\": \"https://schema.org\",\n        \"@type\": \"BarOrPub\",\n        \"name\": \"Cedar Bar\",\n        \"telephone\": \"+1 555 0142\"\n      }\n    </script>\n  </head>\n  <body>\n    <p>Call us on <a href=\"tel:+15550142\">555 0142</a>.</p>\n  </body>\n</html>\n"
          }
        ]
      }
    }
  ]
}
````

The payload names no repository, branch or recipient: the worker's own configuration fixes them, and the
inbox and the writer both refuse a payload that tries. A test (`scripts/__tests__/fix-draft-payload.test.ts`)
parses every payload this makes with the inbox's checker and the writer's. The inbox adds the finding ids
and the site; this command does not know them. Because a pull request carries whole files, a draft is
refused (with the reason on stderr) when the file is over 100,000 characters or the draft is over 16,384
bytes, or when the file is no longer the text the proposal was made from.

`gaugeline apply` and posting the re-check result on the pull request are not built yet (v1.1): both would
write from the command line, which ADR-0010 keeps out of it.

::: warning Uncited
Netlify's and Vercel's documentation could not be opened when this was written, so these are **uncited**:
that the first matching rule in `_redirects` wins (the fixer refuses when an earlier pattern could match
rather than rely on it), that `301` is the default status, that paths are matched case-insensitively and
without a trailing slash (the fixer treats them as the same, to be safe), and that a `vercel.json` entry
`{ "source", "destination", "statusCode" }` is the shape. Check the proposal's diff against your host's
page.
:::
