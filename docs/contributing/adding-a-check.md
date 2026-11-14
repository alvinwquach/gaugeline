# Adding a check

One command scaffolds a new check in every place it lives:

```sh title=Terminal
$ pnpm new:check missing-alt-text --area visitors --severity medium --title "Some images have no description"
packages/core/src/checks/missing-alt-text.ts
packages/core/src/checks/__tests__/missing-alt-text.test.ts
packages/fixtures/sites/missing-alt-text/
packages/core/src/checks/index.ts
.changeset/missing-alt-text.md
docs/check-ids.lock.json
Next: fill in the TODO text, then pnpm gen:checks
```

Areas: `search`, `visitors`, `sales`, `leads`, `security`, `launch`. Severities: `high`, `medium`, `low`.

## The six places

1. **The check** (`packages/core/src/checks/<id>.ts`): its title, what it catches, why it matters, how
   to fix it, and the technical line. These five strings _are_ the docs entry: the checks reference
   is generated from them. The scaffold's rule flags a placeholder page; replace it with the real rule.
   It also needs a **size** (`"S"`, `"M"` or `"L"`: 1, 3 or 8 points, by the kind of fix and not by
   severity), a `done` sentence (what fixed looks like, as Gaugeline would see it when it runs again) and
   an `estimateChanges` sentence (what makes the fix smaller or bigger than its size says). The work order
   (`gaugeline brief`) reads all three through the registry, and `defineCheck` throws when the size is missing.
   Small is a contained change in one place, Medium touches a component, a setting or another system, and
   Large changes something shared or needs a decision or content from someone else first.
2. **Its test**: one page that passes and one that fails, with the evidence string asserted exactly.
3. **A fixture site** (`packages/fixtures/sites/<id>/`): `index.html` shows the problem,
   `clean.html` does not. See CONTRIBUTING → Adding a fixture site.
4. **The registration** in `packages/core/src/checks/index.ts`, kept sorted by id.
5. **A changeset**: a minor bump with "New check: `<title>`." The checks reference then shows "Since" the
   next version for it; a release stamps the real one (see
   [Migration guides, Since badges and the feed](/docs/contributing/migration-guides)).
6. **The id** in `docs/check-ids.lock.json`. Ids are never reused: a retired id is refused.

## Before you open the pull request

The scaffold's tests pass and it typechecks, so you can work in small steps. But every text field
starts with `TODO`, and `pnpm gen:checks` refuses TODO text, so the scaffold cannot reach `main`
unfinished. When the text is written, run `pnpm gen:checks` to see `docs/checks.data.json` regenerate (do not commit it: CI and the job on main do; see CONTRIBUTING.md, "Generated files").

## Static checks: checks that read a repository

Most checks read a page. A static check reads the files of a repository instead (a `next.config`, a route handler, `package.json`, a CI workflow), from a folder the person names. It makes no request and runs no code.

- **The input** is a `LocalSourceInput` (`packages/core/src/local-source/run.ts`), not a page: `defineCheck<LocalSourceInput>`. Look a file up with `staticFile(input, "package.json")`, which says whether it was read, was not read (and why), or is not there. Put the check under `packages/core/src/checks/static/`.
- **The reader** (`readLocalSource`, `packages/core/src/local-source/read.ts`) is not the content adapter, which refuses `package.json`, lockfiles and `tsconfig` on purpose. It only reads. It never follows a link out of the folder, caps the number and size of files, skips `node_modules` and `.git`, and refuses `.env*` and other secret-looking files without keeping their text. A check never prints a value it finds in a file.
- **Not sure is not a pass.** A file the check needs that is absent or was not read is `ctx.couldNotCheck(...)`, never an empty result. A folder the reader could not finish never passes a check; the runner makes sure of that.
- **Register it** in `STATIC_CHECKS` (`local-source/run.ts`). The four lists that name every pack (`packages/cli/src/builtin-ids.ts`, `packages/core/src/index.ts`, `scripts/gen-checks.ts` and `scripts/lib/catalogue-ids.ts`) already include `STATIC_CHECKS`, so adding to the array is enough.
- **Cite framework behaviour** in the check's source comment as `// [docs] <package>@<version> > <section> - <url>`, or `// [GC] no source found (uncited)`.
- **Two fixtures**: a folder that fails and one that passes, both invented (a bar, a clinic, a shop; never a real client).
