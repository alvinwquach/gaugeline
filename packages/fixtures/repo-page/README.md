# repo-page

An invented Next.js project (App Router) for Northfield Coaching, with nothing in it but what the
generated route needs to type-check: the tests copy this folder to a temporary one, write the three
files `gaugeline query --page` generates into `src/app/resource/[slug]/`, and run the TypeScript
compiler over the result (`tsc --noEmit`, with `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` on, which is stricter than create-next-app's default).

- `types/stand-ins.d.ts` stands in for `next`, `next/image`, `next/link`, `next/navigation`,
  `@portabletext/react` and `groq`, cut down from their published type declarations, so Next.js,
  React and Sanity are not installed into this repository. Nothing here runs.
- `src/sanity/lib/client.ts` is the client file `sanity init` writes, reduced to `client.fetch`.

Nothing in this folder is a real business, and nothing in it is ever run.
