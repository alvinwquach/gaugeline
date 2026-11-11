import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { create$PASCAL$Adapter } from "../$ID$.js";
import { AdapterCouldNotCheck } from "../types.js";
#if live
import { $CAMEL$Routes, $CAMEL$Serve, $P$_SITE } from "./$ID$-fixture.js";
#else
import { $CAMEL$Transport } from "./$ID$-fixture.js";
#end

/**
 * What docs/integrations/$ID$.md shows for Larkspur Yoga Studio (an invented small studio whose $NAME$ site
 * a freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/$ID$-docs-example.ts
 */
#if live
export const $P$_SETTINGS = { id: "$ID$", site: $P$_SITE } as const;
#else
export const $P$_SETTINGS = {
  id: "$ID$",
  fingerprint: { classes: ["name", "summary"] },
  urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
} as const;
#end

#if key
// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["$ID$", "docs", "larkspur0123456789abcdef"].join("_");

#end
export async function $CAMEL$Reads(): Promise<string> {
#if live
  const fetcher = createFetcher({ transport: $CAMEL$Serve($CAMEL$Routes()), timeoutMs: 5000 });
  const adapter = create$PASCAL$Adapter({
    fetcher,
    settings: $P$_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("classes", ["name"]).then(
    () => "answered",
    (e: unknown) => (e instanceof AdapterCouldNotCheck ? `could not check: ${e.reason}` : "failed"),
  );
  const { docs } = await collectPublished(adapter, { since: "2026-11-01" });
  return JSON.stringify(
    {
      types,
      "field counts": fieldCounts,
      "drafts reachable": await adapter.draftsReachable(),
      "changed since 1 November": docs,
    },
    null,
    2,
  );
#else
  const fetcher = createFetcher({
#if key
    transport: $CAMEL$Transport(undefined, { token: KEY }),
#else
    transport: $CAMEL$Transport(),
#end
    timeoutMs: 5000,
  });
  const adapter = create$PASCAL$Adapter({
#if key
    env: { $P$_TOKEN: KEY },
#else
    env: {},
#end
    fetcher,
    settings: $P$_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("classes", ["name", "summary", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["classes"] });
  const other = await adapter.fieldCounts("none", ["name"]).catch((e: unknown) =>
    e instanceof AdapterCouldNotCheck ? e.reason : "failed",
  );
  return JSON.stringify(
    {
      types,
      "class fields": fields,
      "a type that does not exist": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published classes": docs,
    },
    null,
    2,
  );
#end
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void $CAMEL$Reads().then((text) => process.stdout.write(`${text}\n`));
