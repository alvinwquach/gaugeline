import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

#if live
/**
 * The $NAME$ adapter reads the live site only. It asks for no key: it reads what the site publishes, the
 * same files every visitor can read. `keyKind` is "read-only" because nothing it does can change anything;
 * `noKey` makes the run header say there is no key at all. If the platform's own API is in beta, add
 * `beta: true` (as framer.entry.ts does): the run header then says "(beta)" and the docs page says what may change.
 *
 * Why it reads the live site only (rule 6 of CLAUDE.md, and the release plan in PROGRESS.md):
#if full-access
 * TODO(new:adapter) $NAME$'s key can also write (say what it can change, and where you read that), so
 * Gaugeline does not ask for it, read it or use it.
#else
 * TODO(new:adapter) $NAME$ has no read API (say what you looked for, and where), so there is nothing to ask.
#end
 */
#else
/**
 * The $NAME$ adapter.
#if key
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest ($KEYKIND$). Write the
 * same sentence at the top of docs/integrations/$ID$.md.
#else
 * It reads the platform's public API, which needs no key. TODO(new:adapter) say which endpoints are public.
#end
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
#end
export const $P$_DESCRIPTION: AdapterDescription = {
  name: "$NAME$",
  docsUrl: "https://gaugeline.dev/docs/integrations/$ID$",
  keyKind: "$KEYKIND$",
#if !key
  noKey: true,
#end
};

#if key
/** The variable the key comes from. The adapter imports it from here. */
export const $P$_TOKEN = "$P$_TOKEN";

#end
export const entries: readonly AdapterEntry[] = [
  {
    id: "$ID$",
    name: "$NAME$",
    status: "built",
    describe: $P$_DESCRIPTION,
#if key
    envVars: [$P$_TOKEN],
#end
#if live
    settings: { pageReader: true },
#end
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("$ID$", async () => {
      const { create$PASCAL$Adapter } = await import("./$ID$.js");
      return (c, settings) =>
        create$PASCAL$Adapter({
#if live
          fetcher: c.fetcher,
          site: c.site,
#else
          env: c.env,
          fetcher: c.fetcher,
#end
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
#if live
      key: "read-only (no key at all: it reads the live site only$FULLNOTE$)",
#end
#if !live
#if key
      key: "$KEYKIND$ (TODO(new:adapter) the narrowest key, in one clause)",
#else
      key: "read-only (no key at all: it reads the platform's public API)",
#end
#end
      reads:
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/$ID$)",
    },
    page: {
      slug: "integrations/$ID$",
      title: "$NAME$: content checks for sites built on $NAME$",
    },
  },
];
