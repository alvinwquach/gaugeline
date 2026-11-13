# Versions, settings and licences, read from your code

Some problems on a client's site are not in the page at all. They are in the repository: a library that is two security fixes behind, a setting that makes the build bigger than it should be, a test that passes while the site fails. A freelancer who builds a pub's menu, a clinic's booking page or a shop's checkout on Next.js and Sanity can see them before launch, with no site to point at.

These checks read your repository, not the live site. They belong to the static checks (`gaugeline source <folder>`, see [Checks that read your source](/docs/guides/source-checks)): they read the files of a folder, make no request and run no code. They never open a `.env` file or a key file, and a finding names a file, a line, a version or an advisory id and never prints what else is in a file.

To run one check on its own, name it with `--only`, so the output below stays the same whatever checks are added later:

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-versions-docs.test.ts runs the same command on the same invented folder and compares the output."
$ npx gaugeline source ./my-site --only zod-version-advisory,next-version-advisory
```

**A note on sources.** Documentation checked on: 2026-11-13. Grounded Code was not connected, so nothing below is cited [GC]. The advisories were read from their own pages on the GitHub Advisory Database [docs] and compared with the answer of the npm registry's advisory API (`https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`), which serves the same database for a specific package version. What each check relies on is listed under it.

## An installed version with a published security advisory

Two checks read the version a repository **installs** and compare it with the published advisories for that package. Both read it from the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`), because the range in `package.json` (`^16.0.0`) says what may be installed, not what is. A range with no lockfile is reported as not sure, never as a pass and never as a finding.

| Check                   | Finds                                                                                                                                | Severity       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `zod-version-advisory`  | zod from 4.0.0 up to but not including 4.6.6, the range of GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized collections)  | Fix this first |
| `next-version-advisory` | Next.js below 16.4.1 on the 16 line, or below 15.5.28 on the 15 line (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r) | Fix this first |

The advisories live in Gaugeline's list of published advisories, `packages/core/src/data/library-advisories.json`, the same list the served-library check reads, with the same `verified` flag. An advisory is only enforced when its entry has been compared with its page. An entry that has not been is reported as not sure, with the words "the floor is unverified", and never as a finding.

### zod

Harbor Lane Taproom is an invented bar. Its booking form validates what a guest sends with zod, and the lockfile installs zod 4.6.5.

<!-- source-fixture: zod-version-advisory/fail -->

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-versions-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/zod-version-advisory/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./harbor-lane-taproom --only zod-version-advisory
```

```text title=Output
Read 2 files in ./harbor-lane-taproom. No request was made and no code was run.

✗ The installed zod version has a published security advisory
    pnpm-lock.yaml:9: zod 4.6.5 is installed (package.json asks for ^4.6.0). That version is in the published affected range of GHSA-mrhx-c7xc-m3w5. Fixed in 4.6.6 on this line.

1 to look at, 1 to fix first.
```

The fix is `npm install zod@latest` (or the same with pnpm or yarn), and committing the lockfile. The advisory is rated high: a request with an oversized collection can make validation use all of the server's memory.

**What about zod 3?** The advisory's published range is "below 4.6.6", which includes every zod 3 release, and zod 3 has no fixed release (3.25.76 is the last). But the advisory's own text names 4.6.5 as the last affected version and does not say that zod 3 was tested. Gaugeline therefore does not claim that zod 3 is affected: it says it is not sure, and that leaving the range means moving to zod 4, which is a migration and not a version bump.

<!-- source-fixture: zod-version-advisory/unsure -->

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-versions-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/zod-version-advisory/unsure) and compares the Output block with what it prints."
$ npx gaugeline source ./quayside-pub --only zod-version-advisory
```

```text title=Output
Read 2 files in ./quayside-pub. No request was made and no code was run.

? zod-version-advisory could not be checked: pnpm-lock.yaml:9 installs zod 3.25.76. GHSA-mrhx-c7xc-m3w5 reaches that version, but Gaugeline has not confirmed that zod 3 is affected: the advisory's text names 4.6.5 as the last affected version, and 3.x has no fixed release (3.25.76 is the last). (source:./quayside-pub)

Nothing to look at.
```

Sources for this check: GHSA-mrhx-c7xc-m3w5, "Zod can exhaust memory while validating oversized constrained collections" [docs] (<https://github.com/advisories/GHSA-mrhx-c7xc-m3w5>): affected `< 4.6.6`, patched `4.6.6`, the description says the flaw exists "through 4.6.5". The registry's answer for specific versions agrees: `vulnerable_versions "<4.6.6"` for zod 4.0.0 and 4.6.5, and no advisory for 4.6.6 (read 2026-11-11, and again on 2026-11-13).

### Next.js

Next.js has had several advisories, and the fixed version is different on each line. A single floor ("below 16.4.1") would tell a project on 15.5.28, which is patched, that it is behind, so the check keeps one fixed version per line.

| Installed                         | What Gaugeline says                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 16.0.0 to 16.4.0                  | a finding: fixed in 16.4.1                                                                                               |
| 15.0.0 to 15.5.27                 | a finding: fixed in 15.5.28                                                                                              |
| 16.4.1 or later, 15.5.28 or later | nothing: the version is outside every range in the list                                                                  |
| below 15.0.0                      | not sure: the advisories reach it, but no fixed release exists on its line, and Gaugeline has not confirmed a fix for it |
| a pre-release                     | not sure: the ranges are for releases                                                                                    |

<!-- source-fixture: next-version-advisory/fail -->

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-versions-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/next-version-advisory/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./harbor-lane-taproom --only next-version-advisory
```

```text title=Output
Read 2 files in ./harbor-lane-taproom. No request was made and no code was run.

✗ The installed Next.js version has published security advisories
    package-lock.json:12: Next.js 16.4.0 is installed (package.json asks for ^16.0.0). That version is in the published affected range of GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r. Fixed in 16.4.1 on this line.

1 to look at, 1 to fix first.
```

Two of the three are rated critical (remote code execution without a login, in the image optimization API and in `use cache` functions that return typed arrays), the third high (denial of service with Server Actions). Gaugeline reports that the installed version is in each advisory's published range; it does not say that your site uses the feature involved, and it does not say it was attacked.

A site on Next.js 14, such as the invented Quayside Pub below, gets "not sure" instead of a finding:

<!-- source-fixture: next-version-advisory/unsure -->

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-versions-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/next-version-advisory/unsure) and compares the Output block with what it prints."
$ npx gaugeline source ./quayside-pub --only next-version-advisory
```

```text title=Output
Read 2 files in ./quayside-pub. No request was made and no code was run.

? next-version-advisory could not be checked: package-lock.json:12 installs Next.js 14.2.35. GHSA-2464-fhr4-w9xw reaches that version, but Gaugeline has not confirmed a fix for it: the advisory's published range reaches versions below 15.0.0, and a patched release exists only on the 15 and 16 lines. (source:./quayside-pub)

Nothing to look at.
```

Sources for this check: GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r [docs] (<https://github.com/advisories/GHSA-2464-fhr4-w9xw>, <https://github.com/advisories/GHSA-673q-mjm6-r5xr>, <https://github.com/advisories/GHSA-p3m5-59mp-jv5r>), read on 2026-11-11. The registry's answer for specific versions (read again on 2026-11-13): next 16.4.0 lists all three with `vulnerable_versions ">=16.0.0 <=16.4.0"`; next 15.5.27 lists two (`>=10.0.0 <=15.5.27` and `>=13.0.0 <=15.5.27`); next 15.5.28 and 16.4.1 list none. **Uncited:** the CVE numbers of these advisories were not read from their pages, so Gaugeline does not print or store any; the advisories are named by their GHSA ids.

### What a pass means

A pass says only that the installed version is outside every range in Gaugeline's list, which was compared with its pages on 2026-11-11. An advisory published after that day is not in the list, and a pass is not a statement that the version is safe.
