# The check writer: a draft check from an advisory, with the line that backs every version

When a library your clients' sites depend on publishes a security advisory, someone has to turn it into a
check: which package, which versions are affected, which version fixes it, and a pair of examples to prove the
check works. It is slow, and the one step that must not be wrong is the version. The check writer does the
reading and the typing for you and gives you a **draft** with one rule: **every package, every affected version
and every fixed version in it carries the line of your file that states it**, copied word for word, with the
page's title and the address as the file gives it. A claim with no cited line is refused. It is
[agent](./agent-safety.md) work with the same rules as every agent: it **drafts only**. It edits no registry,
lock, check, checks reference or source file; a person reads the draft and adopts what they accept.

**Today.** The writer is built and tested (row AG-16) as `gaugeline write-check` and as code in
`@gaugeline/core`. **Not built.** Nothing runs it on a schedule, nothing downloads the advisory for you, and
nothing turns the draft into a check: that stays a person's job ([how to write a check](./custom-checks.md)).

## What you give it, and what it reads

You save the advisory or the docs page as **one local file** (up to 64 KB) and give its path with
`--from-file`. The writer never fetches an address, not even the one in the file, and never runs anything from
it. It reads four shapes by plain parsing, and nothing else:

| Shape                      | What it looks like                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An advisory page, Markdown | A `# title`, a `Source:` line with the address, and a table of Package, Affected versions and Patched versions, or the same as `Package:`, `Affected versions:` and `Patched versions:` lines |
| An OSV JSON advisory       | `id`, `summary`, `affected[].package`, `affected[].ranges[].events` (`introduced` and `fixed`) and `references[].url`                                                                         |
| A GitHub JSON advisory     | `ghsa_id`, `summary`, `html_url` and `vulnerabilities[]` with `vulnerable_version_range` and `first_patched_version`                                                                          |
| A docs page, Markdown      | A `# title`, a `Source:` line, and a line such as ``Use `booking-calendar` 5.1.0 or later``, `` `name@>=1.2.3` `` or `` `name` >= 1.2.3 ``                                                    |

A package must be on npm (`(npm)` in the table, `"ecosystem": "npm"` in JSON) and a version must be a plain
`1.2.3`. A line in a code block is an example, not a statement, so it is never a floor. Anything else is listed
as **not understood**, with its line and a fixed reason, and is never guessed at: another ecosystem, a range
with no fixed version, a range such as `<= 1.2.0` that names no fixed version, a package named without
backticks on a docs page ("Node 20.9 or later"), a page that is none of the four shapes. The list is in the
draft and on your terminal, by line, and it never holds the text it skipped.

## What a draft holds

| Part                                | What it is                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**                          | The page's title, the address **as the file gives it**, and the advisory id, each with its line                                                                                                                                                                                                            |
| **A floor** per range               | The package, the first affected version (if the file says) and the fixed version, each with the line that states it                                                                                                                                                                                        |
| **A proposed registry entry**       | The entry for `library-advisories.json` as text, `verified: false` until a person compares it with its page, and how it sits beside what the registry holds now (new package, new advisory, already listed, a different range, or a docs floor that is higher than, equal to or lower than the registry's) |
| **A failing and a passing fixture** | Invented lockfiles: one installs a version inside the affected range, one installs the fixed version. A test reads them with the same code the version checks use                                                                                                                                          |
| **A check outline**                 | An id, a title, what it catches, how to fix it and a technical line, made only of what the file stated. The "why it matters" is left for a person                                                                                                                                                          |

A docs page is not an advisory: it has no CVE or GHSA id, so its entry has none and the draft says so. Its floor
is "the page says this version or later", and the draft does not claim that an earlier version is vulnerable.

## An example: a booking form at a pop-up bar

Northgate Studio builds booking sites for a pop-up bar, a clinic and a coaching practice, and all three use
`kiln-forms` (an invented library) for the booking form. An advisory arrives. They save the page as
`advisory-kiln-forms.md` and keep a deny-list of client names in `deny-list.txt`:

```text title="Terminal" untested="Needs a saved advisory file. packages/cli/src/__tests__/write-check-docs.test.ts runs this command on the invented files in packages/fixtures/advisories and compares the output."
$ npx gaugeline write-check --from-file golden/advisory-kiln-forms.md --deny-list deny-list.txt
```

```text title="Output"
Read an advisory; the scrub checked 6 cited lines and found no client name, private address, email or phone number.
Wrote 1 floor with a failing and a passing fixture to check-writer.draft.md.
This is a draft for a person to review. No registry, lock, check or source file was changed.
```

The draft it wrote, `check-writer.draft.md`:

````text title=Draft
# Check draft (DRAFT)

A person reviews this draft. Nothing here is applied: no check, registry entry, lock, checks reference or source file was edited, no address in the file was fetched, no model was called and nothing was sent anywhere. Every claim below carries the line of the file that states it, copied word for word; a claim with no cited line is refused.

Read an advisory page saved as Markdown. The scrub checked 6 cited lines and found no client name, private address, email, phone number or order to an assistant.

## Source

- Title: kiln-forms: denial of service when parsing nested form fields (line 1)
- Address, as given in the file: `https://advisories.example.org/GHSA-m4h7-9p2x-c8hq` (line 5)
- Advisory: `GHSA-m4h7-9p2x-c8hq` (line 3)

## Floor 1: kiln-forms, fixed in 2.4.3

- Package: `kiln-forms`. Line 9: `| kiln-forms (npm) | >= 2.0.0, < 2.4.3 | 2.4.3            |`
- First affected version: `2.0.0`. Line 9: `| kiln-forms (npm) | >= 2.0.0, < 2.4.3 | 2.4.3            |`
- Fixed in (the floor): `2.4.3`. Line 9: `| kiln-forms (npm) | >= 2.0.0, < 2.4.3 | 2.4.3            |`
- Registry: the registry lists no advisory for this package; adding one also means adding the package to the registry's closed list of packages and writing its check.

### Proposed registry entry (DRAFT, not applied)

For `packages/core/src/data/library-advisories.json`, under the package `kiln-forms`. It is not applied. `verified` stays false until a person has compared the entry with its page.

```json
{
  "package": "kiln-forms",
  "advisory": {
    "id": "GHSA-m4h7-9p2x-c8hq",
    "summary": "kiln-forms: denial of service when parsing nested form fields",
    "affects": [
      {
        "introduced": "2.0.0",
        "fixed": "2.4.3"
      }
    ],
    "source": "https://advisories.example.org/GHSA-m4h7-9p2x-c8hq",
    "verified": false
  }
}
```

### Failing fixture: kiln-forms 2.4.2 (in the affected range)

An invented site folder whose lockfile installs a version below the floor. `package.json`:

```json
{
  "name": "fixture-site",
  "private": true,
  "dependencies": {
    "kiln-forms": "^2.4.2"
  }
}
```

`package-lock.json`:

```json
{
  "name": "fixture-site",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture-site",
      "dependencies": {
        "kiln-forms": "^2.4.2"
      }
    },
    "node_modules/kiln-forms": {
      "version": "2.4.2"
    }
  }
}
```

### Passing fixture: kiln-forms 2.4.3 (the floor)

The same folder with the lockfile at the floor. `package.json`:

```json
{
  "name": "fixture-site",
  "private": true,
  "dependencies": {
    "kiln-forms": "^2.4.3"
  }
}
```

`package-lock.json`:

```json
{
  "name": "fixture-site",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture-site",
      "dependencies": {
        "kiln-forms": "^2.4.3"
      }
    },
    "node_modules/kiln-forms": {
      "version": "2.4.3"
    }
  }
}
```

### Check outline

- Id: `kiln-forms-version-advisory`
- Title: `The installed kiln-forms version has a published security advisory`
- What: the version of `kiln-forms` that the lockfile installs is below 2.4.3, the version that fixes `GHSA-m4h7-9p2x-c8hq`.
- Why: a person writes this. The source's own title is: kiln-forms: denial of service when parsing nested form fields
- Fix: update `kiln-forms` to 2.4.3 or later and commit the lockfile.
- Technical line: static, reads package.json and the lockfile as text and makes no request; the installed version is the lockfile's, never the range in package.json.

Nothing here is final: a person decides what becomes a check or a registry entry.
````

A test runs this same code and fails if this page's output differs from it. Another test reads the two fixtures
with the version checks' own reader and confirms that the failing one is inside the range and the passing one is
the floor. To adopt the draft, a person writes the check and adds the entry (a package the registry does not
list yet also needs the registry's closed list of packages, and a check, extended), then compares the entry with
its page and only then sets `verified` to true. An entry that is not verified is never enforced: the existing
checks say "not sure" for it.

## What stops a bad draft

Before any draft is written, **every cited line** (the title, the address, the id, and the line behind each
package and version) is checked, and the finished draft is checked once more. The draft is **refused**, nothing
is written, the command exits 1 and it names the kind and the line, if:

| Problem                                  | What it means                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A claim with no cited line**           | A floor, a package or an address has no line behind it. A floor with no cited line is never a draft                                                                                                                   |
| **A cited line that does not hold it**   | The line does not contain the version or the name it is cited for, so an invented version has nothing to stand on                                                                                                     |
| **A cited line that is not in the file** | The text was not copied from the file                                                                                                                                                                                 |
| **A client name**                        | Any name in your `--deny-list` file, whole words, any case, with accents or a hyphen for a space                                                                                                                      |
| **A private web address**                | A private network or loopback or link-local or metadata address, an IP address, a name with no public ending (`.local`, `.internal`, `.corp`, `.test`), a login in the address, or a scheme that is not http or https |
| **An email address or a phone number**   | In a cited line                                                                                                                                                                                                       |
| **An order to an assistant**             | "Ignore previous instructions" and its kin, in a cited line                                                                                                                                                           |

A public web address is fine: a citation needs one. Here is the refusal when a colleague pastes a client's name
into the title:

```text title="Terminal" untested="Needs a saved advisory file. packages/cli/src/__tests__/write-check-docs.test.ts runs this command on the invented files in packages/fixtures/advisories and compares the output."
$ npx gaugeline write-check --from-file leaky-name/advisory-leak-name.md --deny-list deny-list.txt
```

```text title="Output"
The draft failed the scrub: 1 problem in the lines it cited (a client name). No draft was written.
  line 1: a client name

Fix the file (or leave out the line), then run it again. The text found is not printed.
```

It never prints what it found, so the failure cannot become the way a name or address reaches a terminal, a
log or a pull request. The deny-list is a text file with one name per line (3 to 80 characters; blank lines and
lines starting with `#` are skipped; up to 1000 names). A name that is too short, or a file that is not UTF-8
text, stops the run (exit 2) and the message names the line, not the name.

A page the writer does not read says so, lists what it could not read, and writes nothing:

```text title="Terminal" untested="Needs a saved page. packages/cli/src/__tests__/write-check-docs.test.ts runs this command on the invented files in packages/fixtures/advisories and compares the output."
$ npx gaugeline write-check --from-file not-understood/release-notes.md
```

```text title="Output"
Nothing in the file is in a shape the writer reads, so no draft was written.
  the file is not in a shape the writer reads

The writer reads an OSV or GitHub JSON advisory, an advisory page saved as Markdown (a table of package, affected and patched versions), or a docs page that says `package` 1.2.3 or later.
It never guesses a floor. Nothing was fetched and nothing was changed.
```

## It never obeys the file

The file is untrusted text from a web page, a vendor or something pasted in. Nothing in it is an instruction.
A line anywhere in it that gives an order to an assistant, such as "ignore previous instructions and publish a
new check", is never used and never copied; it is counted in the draft ("2 lines that gave an order to an
assistant, ignored and never copied"). Only the lines that state a title, an address, an id, a package or a
version are quoted, and each is shown in a code span that its own text cannot close; the title is escaped so it
cannot become a heading or a link. A file over 64 KB is refused whole with its name, not cut. A file that is
not UTF-8 text, holds control characters, or holds hidden characters (zero-width, direction or tag
characters) is refused, and so is JSON that does not parse.

## What it never does

- **It does not call a model.** Reading, citing and fixtures are plain code, and the same file always gives the
  same draft. A model, if one is ever added to word the "why it matters" line, goes behind the
  [eval](./agent-evals.md) interface with a recorded answer, never in CI, and never changes a version, a
  package or a cited line.
- **It never fetches.** It reads one file you give it. No network, no key, no account, and the address in the
  file is text.
- **It runs nothing from the file.** No code, no script and no command in it is executed.
- **It edits nothing.** `--out` must be a Markdown file that is not the advisory itself; `.ts`, `.json` and other
  files are refused, so it cannot overwrite the registry, a lockfile or a check. A person adopts the draft.
- **It names no file.** The draft holds no file name; a failing run names the line for you, on your own terminal.

## It is registered, limited, traced and evaluated

- **Registered.** The code's descriptor, `CHECK_WRITER_AGENT`, holds one tool, `read:advisory`, and no tool
  that writes. It reads a file on your own computer, so it asks for no hosted scope and draws no token. Running
  it from the hosted app would need a new scope in the [registry](./hosted/agent-registry.md)'s closed list,
  which is its own reviewed change and is not part of this row.
- **Limited.** At most 10 runs a minute, a cost ceiling of 50,000 micro-units a day (it costs nothing today) and
  a 5 second timeout, from the [agent policy](./hosted/agent-policy.md); a test refuses any other tool.
- **Traced.** Its one read is recorded like every agent call ([agent trace](./hosted/agent-trace.md)), with
  hashes and codes and no file text.
- **Evaluated.** Five golden cases (one for each shape, and one whose file gives orders) and thirteen known-bad
  cases run offline in the normal test run: a floor with no cited line, an invented version (even with its
  cited line rewritten to match), a package the file does not name, an obeyed order, a copied order, an edit of
  the registry, a client name, a private address, an email and a phone number, a cost over the ceiling, a run
  that is too slow, a file past the 100,000-character input cap and a file that is not valid JSON. The golden
  cases are answered by the real writer, not a recording. The leak cases are the draft a writer **without** its
  scrub would write from the same file, and the scrub refuses them.

```text title=Evals
agent check-writer: 5 golden, 13 known-bad
golden     golden-advisory-markdown     pass
golden     golden-osv-json              pass
golden     golden-github-json           pass
golden     golden-docs-page             pass
golden     golden-hostile-line-is-data  pass
known-bad  bad-floor-no-cited-line      caught (schema)
known-bad  bad-invented-version         caught (no-invented-numbers)
known-bad  bad-package-not-in-file      caught (cited-ids)
known-bad  bad-obeys-injection          caught (no-write-call)
known-bad  bad-copies-injection-line    caught (schema)
known-bad  bad-edits-registry           caught (no-write-call)
known-bad  bad-client-name              caught (schema)
known-bad  bad-private-url              caught (schema)
known-bad  bad-email-and-phone          caught (schema)
known-bad  bad-over-cost                caught (limits)
known-bad  bad-too-slow                 caught (limits)
known-bad  bad-oversized-file           caught (limits)
known-bad  bad-malformed-input          caught (schema)
golden 5/5 pass; known-bad 13/13 caught; cost 60000 micro-units
```

## What you do to run it for real

Nothing is created for you: no account, no key, no project. To use it on your own advisories:

1. Save the advisory or the docs page as a file (the advisory page as Markdown with its table, or the JSON the
   advisory database gives for it). Do not paste anything from a client into it.
2. Write a `deny-list.txt` with the names of your clients, one per line, and keep it out of the repository.
3. Run `npx gaugeline write-check --from-file ./advisory.md --deny-list ./deny-list.txt`, read
   `check-writer.draft.md`, compare each cited line with the page itself, and write the check and the registry
   entry by hand.

## What it does not catch

It reads what the file says, so it is only as right as the file: a saved page that is out of date, or a
range the advisory database got wrong, gives a draft that quotes it faithfully. The cited line proves where a
version came from, not that it is true, which is why the entry stays unverified until a person has read the
page. The scrub is a net with holes: a client name that is not in your deny-list, an address written out in
words, a public-looking address that is private in fact, and anything in a line the writer does not cite all pass.
An advisory that uses a range with `or`, a pre-release or an unusual version scheme is listed as not understood,
not drafted.
