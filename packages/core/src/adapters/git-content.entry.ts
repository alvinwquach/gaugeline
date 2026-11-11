import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Content kept in a repository: Markdown and MDX with front matter, JSON and YAML files. It reads a
 * folder on this computer (no key at all) or a repository on GitHub (an optional token with Contents:
 * read). The line in a run header names the key kind for the GitHub token; a local folder sends nothing.
 */
export const GIT_CONTENT_DESCRIPTION: AdapterDescription = {
  name: "Content kept in git",
  docsUrl: "https://gaugeline.dev/docs/integrations/git-content",
  keyKind: "read-only",
};

/**
 * The variable the GitHub token is read from: the same one renewals use (renewals/tokens.ts), so one read-only
 * token does for both. Written out here, in plain data, because an entry file imports no code (a test keeps the
 * two names equal).
 */
export const GIT_CONTENT_TOKEN = "GAUGELINE_GITHUB_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "git-content",
    name: "Content kept in git",
    status: "built",
    describe: GIT_CONTENT_DESCRIPTION,
    envVars: [GIT_CONTENT_TOKEN],
    // Front matter keys have hyphens ("pub-date"), and the settings name a repository, not a list of addresses.
    settings: { hyphenFields: true, contentFolders: true },
    // The `yaml` parser is reached only through this import(): a run that does not read a repository never loads it.
    load: lazy("git-content", async () => {
      const { createGitContentAdapter } = await import("./git-content.js");
      return (c, settings) =>
        createGitContentAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
          ...(c.site !== undefined ? { site: c.site } : {}),
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (a folder on your computer needs no key; GitHub, for a private repository, a fine-grained token with only Contents: read)",
      reads:
        "Markdown, MDX, JSON and YAML content in the repository: published items from front matter (draft, publish date), addresses from a pattern, field counts and fingerprints. [Folders, patterns and the token](/docs/integrations/git-content)",
    },
    page: {
      slug: "integrations/git-content",
      title: "Content kept in git: content checks for sites whose content lives in the repo",
    },
  },
];
