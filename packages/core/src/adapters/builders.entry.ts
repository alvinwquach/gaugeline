import type { AdapterEntry } from "./entry.js";
import { BUILDERS, builderDescription } from "./builder-platforms.js";
import { lazy } from "./load.js";

/** One adapter id per hosted builder with no content API (builders.ts): the live site only. */
export const entries: readonly AdapterEntry[] = BUILDERS.map((platform, i): AdapterEntry => ({
  id: platform.id,
  name: platform.name,
  status: "built",
  describe: builderDescription(platform),
  settings: { pageReader: true },
  load: lazy(platform.id, async () => {
    const { createBuilderAdapter } = await import("./builders.js");
    return (c, settings) =>
      createBuilderAdapter(platform, {
        fetcher: c.fetcher,
        site: c.site,
        settings,
        ...(c.sleep ? { sleep: c.sleep } : {}),
      });
  }),
  docs: {
    key: "read-only (no key at all: it reads the files the site already publishes)",
    reads: `The live site only: published pages and blog posts from the sitemap and feeds, with their dates. Fields, drafts and members are could not check, with the reason. [Why, and what still runs](/docs/integrations/builders#${platform.anchor})`,
  },
  // One page serves every builder: the first entry carries it.
  ...(i === 0
    ? {
        page: {
          slug: "integrations/builders",
          title:
            "Hosted builders: content checks for sites built on Squarespace and similar builders",
        },
      }
    : {}),
}));
