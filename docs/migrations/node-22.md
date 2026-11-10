# Node 22 and newer

Gaugeline needs Node 22 or newer from version 0.2.0. Node 18 and Node 20 no longer start it. This is a
breaking change, so this page lists everything that has to change on your side.

If you only run `npx gaugeline` on your own computer and `node --version` already prints v22 or higher,
there is nothing to do.

## What you see on an older Node

Gaugeline checks the Node version before it loads anything else. Under Node 20 (or 18) it prints one
line to stderr, prints nothing to stdout, and exits with code 2:

```text title="stderr, exit code 2"
Gaugeline needs Node 22 or newer. This is Node 20.18.0.
```

Exit code 2 means "could not run", not "found problems", so a nightly job that fails with it has not
checked anything. The version in the message is the one that ran.

## An example: a physiotherapy clinic on Vercel

Sam is a freelancer who looks after the website of Harbour Street Physio, a three-room clinic. The site
is Next.js with the opening hours and treatments in Sanity, deployed to Vercel. When Sam built it in
2024 the Vercel project was set to Node 20, and that setting has never been touched since. Sam also has
a nightly job in the clinic's GitHub repository that runs Gaugeline against the live site and emails
the result to the clinic's practice manager.

After Gaugeline 0.2.0 comes out, the nightly job turns red with the one-line message above. Two
different places pin Node 20, and Sam fixes each separately:

1. **The nightly job's own runner** (`.github/workflows/nightly.yml`) asks for Node 20. This is the
   place that failed, and Gaugeline is the only thing it runs.
2. **The clinic's Vercel project** is also on Node 20. Gaugeline does not run there, so it did not
   fail, but Node 20 is past its end of life. Sam moves it too, after checking that the clinic's site
   builds on 22 in a preview deploy.

Sam changes the nightly job first (a one-line edit), confirms the report arrives, and plans the Vercel
change for a quiet afternoon. Gaugeline reads the live site over HTTP, so it never has to run on the
same Node as the site it checks. If the client's build has to stay on Node 20 for a while, run
Gaugeline in its own job on Node 22 and leave the site's build alone.

## What to change

| Where                 | What to set                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| `package.json`        | `"engines": { "node": ">=22" }`                                                       |
| `.nvmrc`              | `22` (or `lts/*` if you always want the newest long-term release)                     |
| GitHub Actions        | `node-version: 22` in `actions/setup-node`, or `[22, 24]` in a test matrix            |
| Vercel                | Project Settings, General, Node.js Version: 22.x (an `engines.node` entry also works) |
| Netlify               | `NODE_VERSION = "22"` under `[build.environment]` in `netlify.toml`, or the `.nvmrc`  |
| A Dockerfile or image | `FROM node:22` (or a newer tag)                                                       |

A GitHub Actions job before and after:

```yaml title=".github/workflows/nightly.yml"
- uses: actions/setup-node@v5
  with:
    node-version: 22 # was 20
- run: npx gaugeline https://harbourstreetphysio.example/ --ci
```

Netlify, if the clinic's site is there instead:

```toml title="netlify.toml"
[build.environment]
  NODE_VERSION = "22" # was "20"
```

## Check that it worked

```sh title=Terminal
$ node --version
v22.23.4
$ npx gaugeline --version
```

Both commands should print a version and exit 0. In CI, look for the job that previously exited 2.

## Staying on the old release for now

The 0.1 releases run on Node 18.17 and newer. If you cannot move a machine yet, pin the version in the
command (`npx gaugeline@0.1`) and write down a date to come back to it: you will not get the checks
added since.
