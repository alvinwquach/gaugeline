# Docs first

Every feature branch starts with the page a user will read. The tests then assert the output that
page shows, so the docs and the tool cannot drift apart.

## The three steps

1. **Write the page.** Add or edit `docs/<slug>.md` and the `--help` text in
   `packages/cli/src/help.ts`, including the exact output a user will see, in a fenced block titled
   `Output` (or a `Terminal` block whose command lines start with `$`).
2. **Write the test that reads the page.** Use `expectedOutput(slug, heading)` from
   `@gaugeline/fixtures` to load that block, and assert the real output against it. The test fails.
3. **Write the code** until the test passes.

```ts
import { expectedOutput } from "@gaugeline/fixtures";

expect(stdout.trimEnd()).toBe(expectedOutput("options", "Usage"));
```

## For coding agents

Give an agent the same order:

> Commit 1: docs/&lt;slug&gt;.md and the help text only. Stop and show me the intended output.
> Commit 2: failing tests that assert it.
> Commit 3: the code.

A real bug fix that changes no output can skip step 1; label the pull request `internal`.
