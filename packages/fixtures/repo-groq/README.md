# repo-groq

An invented source tree for Copperhill Bakery, a pop-up bakery with a Next.js site on Sanity. It is
what `gaugeline query` reads in its tests and in docs/query-check.md. Nothing here is a real business, and
nothing in it is ever run: Gaugeline only reads these files.

It holds 12 queries in 9 files. Ten parse into 12 shapes (two of them filter on two types), and
two cannot be read:

- `src/app/search/page.tsx` builds its query from a template with a `${...}` in it (concatenated).
- `src/lib/filters.ts` builds its query by joining strings (concatenated).

The ten readable ones cover a `groq` tagged template (in `.ts`, `.tsx` and `.js`), a `defineQuery`
call with a template and with a string, queries exported from one file for others to import, a
projection that dereferences a reference, a nested object, an array of objects, a parameter and
a draft filter.
