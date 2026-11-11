import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createGitContentAdapter } from "../git-content.js";
import { ASTRO_FILES, HUGO_FILES, NOW, removeTree, writeTree } from "./git-content-fixture.js";

/**
 * What docs/integrations/git-content.md shows for Nettle & Thread (an invented pop-up shop whose Astro
 * site a freelancer built) and the Copper Lantern (an invented cocktail bar on Hugo): the settings
 * entries, and what the adapter reads over the invented folders. The docs test compares the page's
 * blocks with these, so the page cannot drift from the tool.
 */
export const NETTLE_SETTINGS = {
  id: "git-content",
  path: ".",
  folders: {
    blog: { dir: "src/content/blog", permalink: "/blog/{slug}/" },
    stalls: { dir: "src/content/stalls", permalink: "/stalls/{path}" },
  },
  fingerprint: { blog: ["title", "description"] },
} as const;

export const LANTERN_SETTINGS = {
  id: "git-content",
  path: ".",
  folders: { posts: { dir: "content/posts", permalink: "/:section/:slugorfilename/" } },
} as const;

async function inFolder<T>(
  files: Readonly<Record<string, string>>,
  run: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-docs-")));
  try {
    writeTree(cwd, files);
    return await run(cwd);
  } finally {
    removeTree(cwd);
  }
}

const never = createFetcher({
  transport: () => Promise.reject(new Error("a local read makes no request")),
  timeoutMs: 5000,
});

export function nettleReads(): Promise<string> {
  return inFolder(ASTRO_FILES, async (cwd) => {
    const adapter = createGitContentAdapter({
      env: {},
      fetcher: never,
      settings: NETTLE_SETTINGS,
      cwd,
      now: () => NOW,
    });
    const types = await adapter.types();
    const fields = await adapter.fieldCounts("blog", ["title", "description", "subtitle"]);
    const { docs } = await collectPublished(adapter, { types: ["blog"] });
    return JSON.stringify(
      { types, "blog fields": fields, "published posts": docs, unread: adapter.unread() },
      null,
      2,
    );
  });
}

export function lanternReads(): Promise<string> {
  return inFolder(HUGO_FILES, async (cwd) => {
    const adapter = createGitContentAdapter({
      env: {},
      fetcher: never,
      settings: LANTERN_SETTINGS,
      cwd,
      now: () => NOW,
    });
    const types = await adapter.types();
    const { docs } = await collectPublished(adapter);
    return JSON.stringify(
      {
        types,
        "published posts": docs.map((d) => ({ id: d.id, url: d.url })),
        unread: adapter.unread(),
      },
      null,
      2,
    );
  });
}
