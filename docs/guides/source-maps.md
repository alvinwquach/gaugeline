# Source maps and development tools left on

A build can leave two things on a live site that nobody meant to publish: the **source maps** that
turn the minified files back into the original code, and the **development tooling** (a hot reload
client, a development build of React, an API address that only works on the developer's laptop).
Both checks work for any site, whatever it is built with.

## What is read, and what is never asked

Gaugeline reads what the live page already says. It never guesses an address.

- Source maps: for up to 15 script files and 5 stylesheets the page loads from its own site, it reads
  the file's `SourceMap` response header (or the older `X-SourceMap`) and the last
  `//# sourceMappingURL=` comment (`/*# sourceMappingURL=... */` in CSS). If that names a map on the
  same origin, it asks for that one address with a plain `GET`, at most 10 maps. A map on another
  host, a `javascript:` or `file:` value and a redirect are never followed.
- A map counts as public only when what comes back parses as a version 3 source map. A site that
  answers 200 with its home page for every address does not trip it.
- Development tools: the page's HTML and the script files already read are searched. No extra request
  is made. A site that has no `sourceMappingURL` comment is not asked for `app.js.map` anyway: that
  would be guessing a route, which Gaugeline does not do outside the probing checks (run only on sites
  you own or have permission to test).
- A source map holds the original code. Gaugeline never stores, prints or hashes what is inside one.
  The finding shows file paths, how many source files the map lists, whether the original code is
  included, and a size class (small under 100 KB, medium under 1 MB, then large).

## The checks

- `source-maps-public` (fix soon, or worth knowing when a map lists file names only): a file the page
  loads names a source map that anyone can fetch. An inline `data:` map is counted by size without
  being decoded.
- `dev-tools-in-production` (fix first when a development server or build is named, otherwise fix
  soon): the page or a script carries `/@vite/client`, `/@react-refresh`, `/__webpack_hmr`,
  `webpack-dev-server/client`, `webpack-internal://` source names, `/_next/static/development/` or a
  `buildId` of `development`, the React development notice or a `.development.js` library file,
  `NODE_ENV` assigned `development`, or an address on the visitor's own machine
  (`localhost`, `127.0.0.1`, `0.0.0.0` or `[::1]`, with a port).

A file cut at the size cap, a map that answers 401, 403, 429 or a server error, and a map larger than
the cap are listed as could not check. They are never a pass.

The framework packs keep their own dev-tool checks (Astro, SvelteKit, Gatsby, Angular, Hydrogen and the
static site generators) for markers that only mean something on that framework. These two are the
generic ones. So that a site is not told the same thing twice, `dev-tools-in-production` stays quiet
on a page where one of those checks already reports the development server or its tools; on every
other page (a plain site, a Next.js site, or a framework page that check finds nothing on) it still
reads the page and its scripts.

## How to turn source maps off

| Tool    | Setting                                                                                 |
| ------- | --------------------------------------------------------------------------------------- |
| Vite    | `build.sourcemap: false` (the default), or `'hidden'` to keep maps but drop the comment |
| webpack | `devtool: false`, or `hidden-source-map` (a map file with no comment in the bundle)     |
| Next.js | leave `productionBrowserSourceMaps` off (it is off by default)                          |
| Nuxt    | `sourcemap: { client: false }`                                                          |

A `hidden` map with no comment is not named by the file, so it is not found here. If the map is
still on the server, delete it from the deploy, or upload it to your error tracker and keep it out of
the public folder.

## Example: a bakery that shipped its build extras

Fennel Lane Bakery is an invented client: a neighbourhood bakery whose site your freelancer built with
Vite. The deploy included the source maps for the scripts and the stylesheet, and a leftover API
address and a React Refresh import from the developer's own machine.

<!-- fixture: source-maps -->

```sh title=Terminal
$ npx gaugeline fennel-lane.example
```

```text title=Output
✗ Development tools are live on your site
    React Refresh (/@react-refresh) in the page; 127.0.0.1:4010 (an address on the visitor's own machine) in ./app-4c9d.js
! Your site publishes its source maps
    3 files name a source map anyone can fetch: ./app-4c9d.js (2 source files, original code included, small); ./legacy-5b0a.js (1 source file, original code included, small); ./site-7a1b.css (1 source file, names only)
? source-maps-public could not be checked: its source map is on another origin, which is never asked (./vendor-2e7f.js)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 1 to fix first.
```

The three maps are public, and two of them include the original code. The fourth script names a map on another host, which is never asked, so it is listed as could not check. The finding lists the files, not
what is in them. The address on port 4010 means every visitor's browser asks its own computer for the
order list, which fails for everyone. Each check that passed also prints a `✓ <id>` line, left out
above, and the docs runner prints the files' `/assets/` paths as `./`. The output is asserted by `pnpm docs:examples` in CI.

What to do with it: set `build.sourcemap` to `false` in `vite.config.ts` (or upload the maps to your
error tracker first), rebuild, and set the API address variable on the host. Rerun the check: both
findings are gone.
