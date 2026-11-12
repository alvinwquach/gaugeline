# source-maps

An invented bakery site (Fennel Lane Bakery) whose build left its source maps and a bit of dev
setup on the live site, for the source map and dev tool checks (XF-02). Nothing here is a real
business, bundle or deployment; the maps hold two invented file names and invented code.

- `app-4c9d.js` names `app-4c9d.js.map`, which is public and includes the original code
  (`sourcesContent`); the file also holds an API address on port 4010 of the machine it is read on.
- `site-7a1b.css` names `site-7a1b.css.map`, public, file names only.
- `legacy-5b0a.js` has no comment, but its response carries a `SourceMap` header.
- `vendor-2e7f.js` names a map on another host: never asked.
- `quiet-3d1c.js` names a map that answers 404: passes.
- The page's inline script imports `/@react-refresh`, a Vite development address.
