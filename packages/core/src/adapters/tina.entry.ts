import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * TinaCMS keeps its content in git, so this adapter reads the repository: a folder on this computer (no key at
 * all) or a repository on GitHub (an optional token with Contents: read, the same one the git-content adapter
 * and renewals use). It learns the collections from `tina/config.ts`, read as text and never run. The TinaCloud
 * client token is never read: see docs/integrations/tina.md.
 */
export const TINA_DESCRIPTION: AdapterDescription = {
  name: "TinaCMS",
  docsUrl: "https://gaugeline.dev/docs/integrations/tina",
  keyKind: "read-only",
};

/**
 * The variable the GitHub token is read from, the same as git-content's (a test keeps the two names equal). Written
 * out here, in plain data, because an entry file imports no code.
 */
export const TINA_TOKEN = "GAUGELINE_GITHUB_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "tina",
    name: "TinaCMS",
    status: "built",
    describe: TINA_DESCRIPTION,
    envVars: [TINA_TOKEN],
    // The collections come from tina/config.ts, so `folders` is optional here (it names folders by hand).
    settings: { contentFolders: "from-config" },
    // The adapter, the git-content code it stands on and the `yaml` parser are reached only through this import().
    load: lazy("tina", async () => {
      const { createTinaAdapter } = await import("./tina.js");
      return (c, settings) =>
        createTinaAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
          ...(c.site !== undefined ? { site: c.site } : {}),
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (a folder on your computer needs no key; GitHub, for a private repository, a fine-grained token with only Contents: read; the TinaCloud token is never used)",
      reads:
        "The collections in tina/config.ts (read as text, never run) and the Markdown, MDX, JSON and YAML files they point at: published items (draft, publish date), addresses from ui.router, field counts and fingerprints. [Collections, addresses and the token](/docs/integrations/tina)",
    },
    page: {
      slug: "integrations/tina",
      title: "TinaCMS: content checks for sites built on TinaCMS",
    },
  },
];
