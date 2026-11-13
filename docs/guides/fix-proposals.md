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

## The two fixers

| Fixer             | Answers                                        | Reads                                                                                                     | Changes                                            |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `redirect`        | `plan-redirect-missing` (from `--plan --base`) | A Netlify `_redirects` file, or a `vercel.json`                                                           | One added rule: `from`, `to`, `301`                |
| `structured-data` | `facts-match` (from a saved run)               | Pages, templates, scripts and `.json` files that hold JSON-LD (a `ld+json` block or a schema.org context) | One value: the whole value of one JSON-LD property |

Both edit the text of the file in place, in its own layout (tabs or spaces, aligned columns, indentation,
the quote style, Windows line endings). A hand-reformatted file is fine; neither fixer rewrites a file
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
| `--repository <o/n>` | The GitHub repository (`owner/name`), written into each proposal. Optional               |
| `--out <file>`       | The proposals file. Default `gaugeline.proposals.json`                                   |
| `--allow-private`    | Allow a preview on this computer or a private network                                    |

The proposals file is versioned (`"version": 1`) and checked when read: a proposal whose id or diff was
changed by hand is refused. `docs/options.md` has the full `--help`.

## Applying a proposal

This page is about the part that only reads. Applying one is a separate, approved step: the proposal
becomes a **draft** in [the hosted inbox](../hosted/inbox.md), a person approves it, and **your own worker**
opens a draft pull request with **your own token** ([applying an approved fix](../hosted/writer.md),
ADR-0010). The command line never opens a pull request, never
merges and never holds a write token.

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
