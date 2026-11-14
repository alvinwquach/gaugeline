# A token needed at import, and a server file that exports a constant

Two habits in a Next.js and Sanity build make a site harder to run than it needs to be, and one of them blurs what a server file is for. Neither breaks the live site on its own, which is why they stay until a build or a test fails for a reason nobody can explain.

These two checks read the repository, not the live site.

| Check                          | Finds                                                                                               | Severity |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | -------- |
| `token-required-at-import`     | A module that throws at the top level when a content-system token is missing                        | Fix soon |
| `use-server-exports-not-async` | A file that starts with `"use server"` and exports a constant, a plain function, a class or an enum | Fix soon |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request and runs no code. A finding names a file, a line and a name, never a value.

**A note on sources.** Documentation checked on: 2026-11-13. The Next.js documentation site could not be reached when this page was written (the build session's network policy refused it), so the pages below were read as the official Markdown sources in the Next.js repository at the `v16.4.1` tag [docs]: [use server](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/01-directives/use-server.mdx) (the directive "designates a function or file to be executed on the server side"; "All functions in the file are executed on the server"; every example exports only async functions), [Data Security](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx) (lines 243 to 255: put `import "server-only"` in a module to keep it out of client code) and [Environment Variables](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/environment-variables.mdx) (lines 156 to 158: a variable without `NEXT_PUBLIC_` exists only in Node.js). The documentation states no rule about exporting a non-async value from a `"use server"` file, so this page does not say that Next refuses it: that is **uncited**. The advice to read a token lazily, on the draft path only, is also **uncited**. Grounded Code was not connected.

## Example: a pub's menu and enquiry form

Quayside Taproom is an invented pub with a Next.js site and a Sanity menu. Two small things were left in the code:

```text title=The folder
lib/sanity.ts                 makes the content client, and throws if SANITY_API_READ_TOKEN is not set
app/enquiry/actions.ts        a server action file that also exports the largest party the pub takes
```

### A module that needs the secret just to be imported

```json title="Findings: token-required-at-import"
[
  {
    "checkId": "token-required-at-import",
    "severity": "medium",
    "title": "A module needs the content token just to be imported",
    "evidence": "lib/sanity.ts: throws when SANITY_API_READ_TOKEN is missing, as soon as the module is imported.",
    "url": "source:./quayside-site",
    "source": {
      "file": "lib/sanity.ts",
      "line": 5
    }
  }
]
```

`lib/sanity.ts` reads the token and throws when it is missing, at the top level. Every page that imports it, even a page that only reads the published menu, fails to build on a machine without the secret: a freelancer's laptop, a preview deploy, a test run, a CI job. The usual result is a fake token pasted into each of them.

**To fix it**, read the token inside the function that needs it (the draft preview) and throw there. Published reads need no token at all.

### A server file that exports a constant

```json title="Findings: use-server-exports-not-async"
[
  {
    "checkId": "use-server-exports-not-async",
    "severity": "medium",
    "title": "A 'use server' file exports something that is not an async function",
    "evidence": "app/enquiry/actions.ts: exports MAX_GUESTS, a value that is not an async function, from a \"use server\" file.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/enquiry/actions.ts",
      "line": 3
    }
  }
]
```

A file that starts with `"use server"` is a file of server functions that client components import and call, and the examples in the Next.js documentation export only async functions from it. `MAX_GUESTS` is a number: it is not a server function and does not belong in the file. **To fix it**, move the constant to a module of its own and import it where it is needed. If it must stay on the server, start that module with `import "server-only"`, so importing it from a client component fails the build.

## What each check looks at

- **`token-required-at-import`.** A variable named like a content-system token (a content system's name and `TOKEN`, `SECRET` or `KEY`) read at the top level of a module, not inside a function: an `if` on it, or on a constant set from it, whose body throws; an `invariant(` or `assert(` of it; or the variable followed by `??` or `||` and a throw. `NEXT_PUBLIC_` names are left to [`cms-token-in-client-code`](tokens-in-source.md). Scripts, `seed`, `migrations` and `bin` folders, `*.config.*` files and `sanity.cli` files are left alone: a command that needs the token may say so.
- **`use-server-exports-not-async`.** A file whose first statement is `"use server"` with a top-level export of a `const`, `let` or `var` whose value is plainly not async (a literal, an object, an array, `new`, a class, a function, a non-async arrow), a non-async function, a class or an enum. Type-only exports are fine. An export whose kind the text cannot settle is could-not-check, not a pass.

## What it does not cover

- `token-required-at-import` does not follow a check made in another function the module calls at the top level, and does not read a schema that parses the whole environment (`schema.parse(process.env)`), which also throws at import.
- `use-server-exports-not-async` does not look at a function-level `"use server"` directive inside a function body, and does not follow a re-export into another file.
- Neither check says what Next.js does with the export or the throw; both are about the shape of the code.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason. `use-server-exports-not-async` also says so for an export whose kind cannot be told from the text: a call that wraps a function (`export const action = createAction(async () => ...)`), a name imported from elsewhere and `export *`. A folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)
