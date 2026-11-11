import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Content kept in a repository, invented: a pop-up shop's Astro site (a blog collection and a stalls
 * collection kept as YAML), a bar's Hugo site with drafts and a scheduled post, and a Jekyll site with a
 * permalink pattern. Nothing here was recorded from a real repository. The same files are written to a
 * folder (local reads) and answered as GitHub's git trees and blobs (the contract suite), so both
 * sources are tested over the same content.
 */
export const CONTENT_MARKERS = {
  spring: "Spring market opens on the green",
  workshop: "Sewing workshop dates for the autumn",
  swap: "Second hand swap at the old library",
  draft: "Summer sale, not announced yet",
  scheduled: "Boxing day preview for members",
  stallOne: "Nettle and Thread stall by the fountain",
  stallTwo: "Candle maker stall near the gate",
  body: "Bring a bag and a friend",
} as const;

/** "Now" for every test: the scheduled post is after it, everything else before. */
export const NOW = new Date("2026-11-11T12:00:00.000Z");

/** Nettle & Thread: a pop-up shop whose freelancer built the site with Astro content collections. */
export const ASTRO_FILES: Readonly<Record<string, string>> = {
  "src/content/blog/spring-market.md": `---
title: ${CONTENT_MARKERS.spring}
description: Stalls, music and tea.
pubDate: 2026-03-01
updatedDate: 2026-03-10T09:30:00Z
---
${CONTENT_MARKERS.body}
`,
  "src/content/blog/workshop-dates.md": `---
title: ${CONTENT_MARKERS.workshop}
pubDate: 2026-02-01
---
Five Saturdays.
`,
  "src/content/blog/second-hand-swap.mdx": `---
title: ${CONTENT_MARKERS.swap}
description: Bring one, take one.
slug: swap
pubDate: 2026-01-15T10:00:00Z
---
import Banner from "../../components/Banner.astro";

<Banner />
`,
  "src/content/blog/draft-summer.md": `---
title: ${CONTENT_MARKERS.draft}
draft: true
pubDate: 2026-06-01
---
Not yet.
`,
  "src/content/blog/future-sale.md": `---
title: ${CONTENT_MARKERS.scheduled}
pubDate: 2099-01-01
---
Later.
`,
  "src/content/blog/_notes.md": "---\ntitle: Not content\n---\n",
  "src/content/stalls/fountain.yaml": `name: ${CONTENT_MARKERS.stallOne}
opened: 2026-04-01
location: fountain
`,
  "src/content/stalls/gate.yaml": `name: ${CONTENT_MARKERS.stallTwo}
opened: 2026-05-01
`,
  "README.md": "Not in a content folder.\n",
};

export const ASTRO_FOLDERS = {
  blog: { dir: "src/content/blog", permalink: "/blog/{slug}/" },
  stalls: { dir: "src/content/stalls", permalink: "/stalls/{path}" },
} as const;

/** The Copper Lantern: a cocktail bar on Hugo, with a draft, a scheduled post, an expired offer and a page bundle. */
export const HUGO_FILES: Readonly<Record<string, string>> = {
  "content/posts/autumn-menu.md":
    "---\ntitle: Autumn menu\ndate: 2026-10-01\nslug: autumn-drinks\n---\nSeven new drinks.\n",
  "content/posts/winter-menu.md":
    "---\ntitle: Winter menu\ndate: 2026-10-20\ndraft: true\n---\nNot yet.\n",
  "content/posts/new-year.md":
    "---\ntitle: New year party\ndate: 2026-12-30\n---\nBooking opens.\n",
  "content/posts/halloween.md":
    "---\ntitle: Halloween offer\ndate: 2026-10-15\nexpiryDate: 2026-11-01\n---\nOver.\n",
  "content/posts/jazz-night/index.md":
    "---\ntitle: Jazz night\ndate: 2026-09-01\n---\nLast Friday.\n",
  "content/posts/_index.md": "---\ntitle: Posts\n---\n",
  "content/posts/toml-post.md": '+++\ntitle = "Old style"\ndate = 2026-01-01\n+++\nBody.\n',
  "content/posts/broken.md": "---\ntitle: [unclosed\ndate: 2026-01-01\n---\nBody.\n",
};

export const HUGO_FOLDERS = {
  posts: { dir: "content/posts", permalink: "/:section/:slugorfilename/" },
} as const;

/** A coach's Jekyll blog: dated file names, categories, and a front matter permalink on one post. */
export const JEKYLL_FILES: Readonly<Record<string, string>> = {
  "_posts/2026-03-04-first-session.md":
    "---\ntitle: First session\ncategories: [coaching, news]\n---\nHello.\n",
  "_posts/2026-04-10-spring-offer.md":
    "---\ntitle: Spring offer\npermalink: /offers/spring/\n---\nHello.\n",
  "_posts/2026-05-02-hidden.md": "---\ntitle: Hidden\npublished: false\n---\nHello.\n",
  "_posts/2026-06-09-no-category.md":
    "---\ntitle: No category\ndate: 2026-06-09 08:30:00\n---\nHello.\n",
};

export const JEKYLL_FOLDERS = {
  posts: { dir: "_posts", permalink: "/:categories/:year/:month/:day/:title/" },
} as const;

/** Writes files under a folder, creating the folders between. */
export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export const REPO = "nettle-thread/popup-site";
const sha = (p: string, text: string): string =>
  createHash("sha1").update(`${p}\0${text}`).digest("hex");

const json = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

export interface GitHubFixtureOptions {
  /** When set, a request without exactly this bearer token is 401. */
  token?: string;
  /** Called with each request's method, address and headers. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  /** Makes the tree answer `truncated: true`. */
  truncated?: boolean;
  /** Replaces the repository's name the transport answers for. */
  repo?: string;
}

/**
 * GitHub's REST API over a set of files: `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` answers
 * the tree (`{ sha, tree: [{ path, mode, type, sha, size }], truncated }`) and
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}` a blob (`{ sha, size, encoding: "base64", content }`), as the
 * documented responses are shaped. Any other host is a 500, so a request that goes elsewhere fails a test.
 */
export function githubTransport(
  files: Readonly<Record<string, string>> = ASTRO_FILES,
  options: GitHubFixtureOptions = {},
): Transport {
  const repo = options.repo ?? REPO;
  const blobs = new Map<string, string>();
  const tree = Object.entries(files).map(([p, text]) => {
    const id = sha(p, text);
    blobs.set(id, text);
    return { path: p, mode: "100644", type: "blob", sha: id, size: Buffer.byteLength(text) };
  });
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== "api.github.com") return json(500, { message: "wrong host" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { message: "Bad credentials" });
    const treeAt = new RegExp(`^/repos/${repo}/git/trees/([^/]+)$`).exec(url.pathname);
    if (treeAt && url.searchParams.get("recursive") === "1")
      return json(200, {
        sha: "0".repeat(40),
        tree: [{ path: "src", mode: "040000", type: "tree", sha: "1".repeat(40) }, ...tree],
        truncated: options.truncated === true,
      });
    const blobAt = new RegExp(`^/repos/${repo}/git/blobs/([0-9a-f]{40})$`).exec(url.pathname);
    if (blobAt) {
      const text = blobs.get(blobAt[1] ?? "");
      if (text === undefined) return json(404, { message: "Not Found" });
      return json(200, {
        sha: blobAt[1],
        size: Buffer.byteLength(text),
        encoding: "base64",
        content: (
          Buffer.from(text)
            .toString("base64")
            .match(/.{1,60}/g) ?? []
        ).join("\n"),
      });
    }
    return json(404, { message: "Not Found" });
  };
}
