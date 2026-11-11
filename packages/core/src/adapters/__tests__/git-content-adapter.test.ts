import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { hashValue } from "../fingerprint.js";
import { createGitContentAdapter } from "../git-content.js";
import { parseContent, stateOf } from "../git-content-parse.js";
import {
  PERMALINK_TOKENS,
  expandPermalink,
  isPermalinkPattern,
  namesOf,
  nuxtPath,
} from "../git-content-permalink.js";
import { GIT_CONTENT_LIMITS } from "../git-content-source.js";
import { createAdapters, BUILT_ADAPTERS, PLANNED_ADAPTERS } from "../registry.js";
import { AdapterCouldNotCheck, type AdapterSettings } from "../types.js";
import {
  ASTRO_FILES,
  ASTRO_FOLDERS,
  CONTENT_MARKERS,
  HUGO_FILES,
  HUGO_FOLDERS,
  JEKYLL_FILES,
  JEKYLL_FOLDERS,
  NOW,
  REPO,
  githubTransport,
  removeTree,
  writeTree,
} from "./git-content-fixture.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-git-content-")));
});
afterEach(() => removeTree(dir));

const never: Transport = () => Promise.reject(new Error("a local read makes no request"));
const fetcher = createFetcher({ transport: never, timeoutMs: 5000 });

function local(
  files: Readonly<Record<string, string>>,
  folders: NonNullable<AdapterSettings["folders"]>,
  extra: { fingerprint?: Record<string, string[]>; limits?: typeof GIT_CONTENT_LIMITS } = {},
) {
  writeTree(dir, files);
  return createGitContentAdapter({
    env: {},
    fetcher,
    now: () => NOW,
    limits: extra.limits,
    settings: {
      id: "git-content",
      path: dir,
      folders,
      ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    },
  });
}

const all = async (a: ReturnType<typeof local>, options?: Parameters<typeof collectPublished>[1]) =>
  (await collectPublished(a, options)).docs;

describe("an Astro content collection kept in the repository: integration", () => {
  it("counts the published items per folder: the draft, the scheduled post and _files are not", async () => {
    const a = local(ASTRO_FILES, ASTRO_FOLDERS);
    expect(await a.types()).toEqual([
      { name: "blog", count: 3 },
      { name: "stalls", count: 2 },
    ]);
  });

  it("gives ids, folders, addresses from the pattern, and dates from the front matter", async () => {
    const docs = await all(local(ASTRO_FILES, ASTRO_FOLDERS), { types: ["blog"] });
    expect(docs).toEqual([
      {
        id: "src/content/blog/second-hand-swap.mdx",
        type: "blog",
        url: "/blog/swap/",
        slug: "swap",
        publishedAt: "2026-01-15T10:00:00.000Z",
        updatedAt: "2026-01-15T10:00:00.000Z",
        fieldHashes: {},
      },
      {
        id: "src/content/blog/spring-market.md",
        type: "blog",
        url: "/blog/spring-market/",
        slug: "spring-market",
        publishedAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-10T09:30:00.000Z",
        fieldHashes: {},
      },
      {
        id: "src/content/blog/workshop-dates.md",
        type: "blog",
        url: "/blog/workshop-dates/",
        slug: "workshop-dates",
        publishedAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("a YAML collection: one file per stall, addressed by its path in the folder", async () => {
    const docs = await all(local(ASTRO_FILES, ASTRO_FOLDERS), { types: ["stalls"] });
    expect(docs.map((d) => [d.id, d.url])).toEqual([
      ["src/content/stalls/fountain.yaml", "/stalls/fountain"],
      ["src/content/stalls/gate.yaml", "/stalls/gate"],
    ]);
  });

  it("counts how many items have a field, and hashes only the configured fields", async () => {
    const a = local(ASTRO_FILES, ASTRO_FOLDERS, {
      fingerprint: { blog: ["title", "description"] },
    });
    expect(await a.fieldCounts("blog", ["title", "description", "subtitle"])).toEqual({
      title: 3,
      description: 2,
      subtitle: 0,
    });
    const docs = await all(a, { types: ["blog"] });
    const spring = docs.find((d) => d.slug === "spring-market");
    expect(spring?.fieldHashes).toEqual({
      title: hashValue(CONTENT_MARKERS.spring),
      description: hashValue("Stalls, music and tea."),
    });
    expect(JSON.stringify(docs)).not.toContain(CONTENT_MARKERS.spring);
    const workshop = docs.find((d) => d.slug === "workshop-dates");
    expect(Object.keys(workshop?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("a changed field changes its hash and nothing else", async () => {
    const before = await all(
      local(ASTRO_FILES, ASTRO_FOLDERS, { fingerprint: { blog: ["title"] } }),
    );
    removeTree(dir);
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-git-content-")));
    const edited = {
      ...ASTRO_FILES,
      "src/content/blog/spring-market.md":
        ASTRO_FILES["src/content/blog/spring-market.md"]?.replace(
          CONTENT_MARKERS.spring,
          "Spring market moves indoors",
        ) ?? "",
    };
    const after = await all(local(edited, ASTRO_FOLDERS, { fingerprint: { blog: ["title"] } }));
    const changed = after.filter((d, i) => JSON.stringify(d) !== JSON.stringify(before[i]));
    expect(changed.map((d) => d.slug)).toEqual(["spring-market"]);
  });

  it("an item with no date has no date: the file's modification time is never used", async () => {
    const a = local({ "c/page.md": "---\ntitle: Undated\n---\n" }, { pages: { dir: "c" } });
    utimesSync(path.join(dir, "c", "page.md"), new Date("2020-05-05"), new Date("2020-05-05"));
    const [doc] = await all(a);
    expect(doc?.publishedAt).toBeUndefined();
    expect(doc?.updatedAt).toBeUndefined();
  });

  it("since keeps items changed at or after it, and an undated item; limit stops early", async () => {
    const a = local(ASTRO_FILES, ASTRO_FOLDERS);
    const recent = await all(a, { types: ["blog"], since: "2026-02-15" });
    expect(recent.map((d) => d.slug)).toEqual(["spring-market"]);
    expect(await all(a, { limit: 2 })).toHaveLength(2);
  });

  it("draftsReachable is not-applicable: a draft is a file in the same folder, not another place", async () => {
    expect(await local(ASTRO_FILES, ASTRO_FOLDERS).draftsReachable()).toBe("not-applicable");
  });
});

describe("a Hugo site with drafts: integration", () => {
  const hugo = () => local(HUGO_FILES, HUGO_FOLDERS);

  it("leaves out the draft, the scheduled post, the expired offer and _index.md", async () => {
    const docs = await all(hugo());
    expect(docs.map((d) => d.id)).toEqual([
      "content/posts/autumn-menu.md",
      "content/posts/jazz-night/index.md",
    ]);
  });

  it("uses the slug field, the section and a page bundle's folder for the address", async () => {
    const docs = await all(hugo());
    expect(docs.map((d) => d.url)).toEqual(["/posts/autumn-drinks/", "/posts/jazz-night/"]);
  });

  it("names the files it could not read, without quoting them: TOML front matter and broken YAML", async () => {
    const a = hugo();
    await all(a);
    const { total, files } = a.unread();
    expect(total).toBe(2);
    expect(files).toEqual([
      {
        path: "content/posts/broken.md",
        reason: expect.stringMatching(/^front matter is not valid YAML \(.+\) at line \d+$/),
      },
      {
        path: "content/posts/toml-post.md",
        reason: "has TOML front matter (+++), which is not read yet",
      },
    ]);
    expect(JSON.stringify(files)).not.toContain("unclosed");
  });
});

describe("a Jekyll permalink pattern: integration", () => {
  const jekyll = () => local(JEKYLL_FILES, JEKYLL_FOLDERS);

  it("fills year, month, day, title and categories from the file name and the front matter", async () => {
    const docs = await all(jekyll());
    expect(docs.map((d) => [d.id, d.url])).toEqual([
      ["_posts/2026-03-04-first-session.md", "/coaching/news/2026/03/04/first-session/"],
      // The post's own permalink wins over the folder's pattern.
      ["_posts/2026-04-10-spring-offer.md", "/offers/spring/"],
      ["_posts/2026-06-09-no-category.md", "/2026/06/09/no-category/"],
    ]);
  });

  it("published: false is not published", async () => {
    expect((await all(jekyll())).map((d) => d.slug)).not.toContain("hidden");
  });

  it("names a built-in style: pretty and date", async () => {
    const files = { "_posts/2026-03-04-a.md": "---\ntitle: A\n---\n" };
    const pretty = await all(local(files, { posts: { dir: "_posts", permalink: "pretty" } }));
    expect(pretty[0]?.url).toBe("/2026/03/04/a/");
    removeTree(dir);
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-git-content-")));
    const date = await all(local(files, { posts: { dir: "_posts", permalink: "date" } }));
    expect(date[0]?.url).toBe("/2026/03/04/a.html");
  });
});

describe("permalink patterns: unit", () => {
  const values = { slug: "a b", year: "2026", month: "03", day: "04", section: "posts" };

  it("fills {tokens} and :tokens alike, encodes values, and folds empty parts", () => {
    expect(expandPermalink("/{section}/:year/{slug}/", values)).toBe("/posts/2026/a%20b/");
    expect(expandPermalink("/:categories/:year/", { ...values, categories: "" })).toBe("/2026/");
  });

  it("gives no address when a token has no value, rather than a made-up one", () => {
    expect(expandPermalink("/blog/{slug}", {})).toBe("");
    expect(expandPermalink("/{year}/{slug}", { slug: "x" })).toBe("");
  });

  it("refuses dot parts and keeps an https address's origin", () => {
    expect(expandPermalink("/blog/{slug}", { slug: ".." })).toBe("");
    expect(expandPermalink("https://shop.example/menu/{slug}", { slug: "tea" })).toBe(
      "https://shop.example/menu/tea",
    );
  });

  it("accepts a path or an https address with known tokens, and nothing else", () => {
    for (const ok of [
      "/blog/{slug}",
      "/:section/:slug/",
      "date",
      "pretty",
      "https://x.example/{id}",
    ])
      expect(isPermalinkPattern(ok)).toBe(true);
    for (const bad of [
      "blog/{slug}",
      "//evil.example/{slug}",
      "/blog/{nope}",
      "/blog/:nope",
      "/blog/{slug}?x=1",
      "javascript:alert(1)",
      "/a b",
      "http://x.example/{slug}",
    ])
      expect(isPermalinkPattern(bad)).toBe(false);
  });

  it("reads Jekyll's date prefix, Hugo's page bundles and Nuxt's ordering prefixes", () => {
    expect(namesOf("2026-03-04-first-session.md")).toMatchObject({
      title: "first-session",
      filename: "2026-03-04-first-session",
      date: { year: "2026", month: "03", day: "04" },
    });
    expect(namesOf("jazz-night/index.md")).toMatchObject({
      path: "jazz-night",
      filename: "jazz-night",
    });
    expect(namesOf("a/b.mdx").path).toBe("a/b");
    expect(nuxtPath("1.guide/2.start")).toBe("guide/start");
    expect(nuxtPath("2026-recap")).toBe("2026-recap");
  });

  it("documents every token the code has, and the docs page lists them in the same order", () => {
    expect(Object.keys(PERMALINK_TOKENS)).toContain("nuxt_path");
  });
});

describe("front matter and published state: unit", () => {
  const records = (text: string, kind: "markdown" | "json" | "yaml" = "markdown") => {
    const r = parseContent(text, kind);
    return r.ok ? r.records : r.reason;
  };

  it("reads YAML front matter, CRLF files and a byte order mark; a file with none is one record with no fields", () => {
    expect(records("---\ntitle: A\n---\nbody")).toEqual([{ title: "A" }]);
    expect(records("﻿---\r\ntitle: A\r\n---\r\nbody")).toEqual([{ title: "A" }]);
    expect(records("just text")).toEqual([{}]);
    expect(records("---\n---\nbody")).toEqual([{}]);
  });

  it("reports what cannot be read without quoting the text", () => {
    expect(records("---\ntitle: A\nno end")).toBe("has front matter that is never closed with ---");
    expect(records("---\n- a\n- b\n---\n")).toBe("front matter is not a set of fields");
    expect(String(records("---\ntitle: [secret\n---\n"))).not.toContain("secret");
    expect(records("{ nope", "json")).toBe("is not valid JSON");
    expect(records("[1, 2]", "json")).toBe("is not a record or a list of records");
  });

  it("a YAML bomb is refused, not expanded", () => {
    const bomb = `---\na: &a [x,x,x,x,x,x,x,x,x]\n${"bcdefghijklmnopqrstuvwxyz"
      .split("")
      .map(
        (c, i) =>
          `${c}: &${c} [${Array.from({ length: 9 }, () => (i === 0 ? "*a" : `*${"bcdefghijklmnopqrstuvwxyz"[i - 1]}`)).join(",")}]`,
      )
      .join("\n")}\n---\n`;
    expect(typeof records(bomb)).toBe("string");
  });

  it("a JSON or YAML list is one item per record", () => {
    expect(records('[{"a":1},{"a":2}]', "json")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(records("- a: 1\n- a: 2\n", "yaml")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("published state: draft, published, permalink false, scheduled and expired", () => {
    const at = Date.parse("2026-06-01T00:00:00Z");
    const live = (d: Record<string, unknown>) => stateOf(d, at).published;
    expect(live({})).toBe(true);
    expect(live({ draft: true })).toBe(false);
    expect(live({ draft: "true" })).toBe(false);
    expect(live({ draft: false })).toBe(true);
    expect(live({ published: false })).toBe(false);
    expect(live({ permalink: false })).toBe(false);
    expect(live({ date: "2026-06-02" })).toBe(false);
    expect(live({ publishDate: "2026-05-01", date: "2030-01-01" })).toBe(true);
    expect(live({ date: "2026-05-01", expiryDate: "2026-05-31" })).toBe(false);
  });

  it("a time with no zone is UTC, wherever the run is", () => {
    expect(stateOf({ date: "2026-03-01 10:00:00" }, 0).publishedAt).toBe(
      "2026-03-01T10:00:00.000Z",
    );
    expect(stateOf({ date: "not a date" }, 0).publishedAt).toBeUndefined();
  });
});

describe("a local folder stays inside the repository: edge cases", () => {
  it("never follows a link out of the repository, to a file or to a folder", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-outside-")));
    try {
      writeFileSync(path.join(outside, "secret.md"), "---\ntitle: Outside\n---\n");
      mkdirSync(path.join(outside, "dir"));
      writeFileSync(path.join(outside, "dir", "inner.md"), "---\ntitle: Inner\n---\n");
      writeTree(dir, { "repo/content/ok.md": "---\ntitle: Ok\n---\n" });
      try {
        symlinkSync(path.join(outside, "secret.md"), path.join(dir, "repo/content/link.md"));
        symlinkSync(path.join(outside, "dir"), path.join(dir, "repo/content/linked-dir"));
        symlinkSync(outside, path.join(dir, "repo/escape"));
      } catch {
        return; // links cannot be made here (Windows without the privilege)
      }
      const make = (folder: string) =>
        createGitContentAdapter({
          env: {},
          fetcher,
          now: () => NOW,
          settings: {
            id: "git-content",
            path: path.join(dir, "repo"),
            folders: { c: { dir: folder } },
          },
        });
      const a = make("content");
      expect((await all(a)).map((d) => d.id)).toEqual(
        ["repo/content/ok.md"].map((p) => p.replace("repo/", "")),
      );
      expect(a.unread().files.map((f) => f.reason)).toEqual([
        "is a link, which is never followed",
        "is a link, which is never followed",
      ]);
      // A folder that is itself a link out of the repository is could-not-check.
      await expect(all(make("escape"))).rejects.toThrow(AdapterCouldNotCheck);
    } finally {
      removeTree(outside);
    }
  });

  it("a content folder with .. or an absolute path is refused by the settings and by the reader", async () => {
    const entry = (d: string) => ({
      adapters: [{ id: "git-content", path: ".", folders: { c: { dir: d } } }],
    });
    for (const bad of ["../x", "a/../../x", "/etc", "a//b", ".hidden/.."])
      expect(adaptersConfigSchema.safeParse(entry(bad)).success, bad).toBe(false);
    expect(adaptersConfigSchema.safeParse(entry("src/content")).success).toBe(true);
    const a = createGitContentAdapter({
      env: {},
      fetcher,
      settings: { id: "git-content", path: dir, folders: { c: { dir: "../x" } } },
    });
    await expect(a.types()).rejects.toThrow(/not inside the repository/);
  });

  it("a folder that is not there is could-not-check with the folder named, not an empty count", async () => {
    const a = createGitContentAdapter({
      env: {},
      fetcher,
      settings: { id: "git-content", path: dir, folders: { c: { dir: "nothing" } } },
    });
    await expect(a.types()).rejects.toThrow(/"nothing" does not exist/);
    const b = createGitContentAdapter({
      env: {},
      fetcher,
      settings: {
        id: "git-content",
        path: path.join(dir, "no-such"),
        folders: { c: { dir: "x" } },
      },
    });
    await expect(b.types()).rejects.toThrow(AdapterCouldNotCheck);
  });

  it("caps the number of files and the size of a file", async () => {
    const files: Record<string, string> = {
      "c/big.md": `---\ntitle: Big\n---\n${"x".repeat(300)}`,
    };
    for (let i = 0; i < 4; i++) files[`c/p${i}.md`] = "---\ntitle: P\n---\n";
    const limits = { ...GIT_CONTENT_LIMITS, files: 10, fileBytes: 200 };
    const a = local(files, { c: { dir: "c" } }, { limits });
    expect(await a.types()).toEqual([{ name: "c", count: 4 }]);
    expect(a.unread().files).toEqual([{ path: "c/big.md", reason: "is larger than 0 KiB" }]);
    const tight = local({ ...files }, { c: { dir: "c" } }, { limits: { ...limits, files: 3 } });
    await expect(tight.types()).rejects.toThrow(/more than 3 content files/);
  });

  it("does not read node_modules, .git or _drafts, or a file with another extension", async () => {
    const a = local(
      {
        "c/a.md": "---\ntitle: A\n---\n",
        "c/node_modules/x.md": "---\ntitle: X\n---\n",
        "c/.git/y.md": "---\ntitle: Y\n---\n",
        "c/_drafts/z.md": "---\ntitle: Z\n---\n",
        "c/image.png": "not content",
        "c/notes.txt": "not content",
      },
      { c: { dir: "c" } },
    );
    expect((await all(a)).map((d) => d.id)).toEqual(["c/a.md"]);
  });

  it("a JSON list in one file is one item per record, id with its position", async () => {
    const a = local(
      {
        "data/menu.json": JSON.stringify([
          { slug: "tea", name: "Tea" },
          { slug: "cake", name: "Cake", draft: true },
          { slug: "soup" },
        ]),
      },
      { menu: { dir: "data", permalink: "/menu/{slug}" } },
    );
    expect((await all(a)).map((d) => [d.id, d.url])).toEqual([
      ["data/menu.json#0", "/menu/tea"],
      ["data/menu.json#2", "/menu/soup"],
    ]);
  });
});

describe("reading from GitHub: integration", () => {
  const TOKEN = ["gh", "docs", "nettle0123456789abcdef"].join("_");
  const github = (
    transport: Transport,
    env: Record<string, string> = { GAUGELINE_GITHUB_TOKEN: TOKEN },
    folders = ASTRO_FOLDERS,
    repo = REPO,
  ) =>
    createGitContentAdapter({
      env,
      fetcher: createFetcher({ transport, timeoutMs: 5000 }),
      sleep: () => Promise.resolve(),
      now: () => NOW,
      settings: { id: "git-content", github: { repo }, folders },
    });

  it("reads the same content as a local folder, with GET only, to api.github.com only", async () => {
    const seen: Array<{ method: string; host: string; auth: string | undefined }> = [];
    const a = github(
      githubTransport(ASTRO_FILES, {
        token: TOKEN,
        onRequest: (method, url, headers) =>
          seen.push({ method, host: url.host, auth: headers.authorization }),
      }),
    );
    const remote = await all(a);
    expect(remote).toEqual(await all(local(ASTRO_FILES, ASTRO_FOLDERS)));
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect([s.method, s.host]).toEqual(["GET", "api.github.com"]);
    expect(JSON.stringify(remote)).not.toContain(TOKEN);
  });

  it("works with no token for a public repository: no Authorization header is sent", async () => {
    const auth: Array<string | undefined> = [];
    const a = github(
      githubTransport(ASTRO_FILES, { onRequest: (_m, _u, h) => auth.push(h.authorization) }),
      {},
    );
    expect(await a.types()).toEqual([
      { name: "blog", count: 3 },
      { name: "stalls", count: 2 },
    ]);
    expect(auth.every((h) => h === undefined)).toBe(true);
  });

  it("the token is dropped when GitHub redirects to another origin", async () => {
    const seen: Array<{ host: string; auth: string | undefined }> = [];
    const inner = githubTransport(ASTRO_FILES, { token: TOKEN });
    const transport: Transport = (url, req) => {
      seen.push({ host: url.host, auth: req.headers.authorization });
      if (url.host === "api.github.com" && url.pathname.includes("/git/trees/"))
        return Promise.resolve({
          status: 302,
          headers: { location: "https://objects.example/tree" },
          body: Readable.from([]),
        });
      if (url.host === "objects.example")
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([Buffer.from('{"tree":[],"truncated":false}')]),
        });
      return inner(url, req);
    };
    const a = github(transport);
    expect(await a.types()).toEqual([
      { name: "blog", count: 0 },
      { name: "stalls", count: 0 },
    ]);
    const elsewhere = seen.filter((s) => s.host !== "api.github.com");
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const s of elsewhere) expect(s.auth).toBeUndefined();
  });

  it("a private or missing repository (404) and a bad token (401) are could-not-check with a reason, token blanked", async () => {
    const missing = github(githubTransport(ASTRO_FILES, { repo: "someone/else" }));
    const err404: unknown = await missing.types().catch((e: unknown) => e);
    expect(err404).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err404 as AdapterCouldNotCheck).reason).toMatch(/HTTP 404.*GAUGELINE_GITHUB_TOKEN/);
    const wrong = github(githubTransport(ASTRO_FILES, { token: "other" }));
    const err401: unknown = await wrong.types().catch((e: unknown) => e);
    expect((err401 as AdapterCouldNotCheck).reason).toMatch(
      /did not accept GAUGELINE_GITHUB_TOKEN/,
    );
    expect((err401 as AdapterCouldNotCheck).reason).not.toContain(TOKEN);
  });

  it("a tree GitHub cut short (truncated) is could-not-check, never a count of part of it", async () => {
    const a = github(githubTransport(ASTRO_FILES, { truncated: true }));
    await expect(a.types()).rejects.toThrow(/too large for GitHub to list/);
  });

  it("refuses a repository or branch name that could change the address, before any request", async () => {
    const asked: string[] = [];
    const spy: Transport = (url, req) => {
      asked.push(url.href);
      return githubTransport()(url, req);
    };
    const named = (repo: string, ref?: string) =>
      createGitContentAdapter({
        env: {},
        fetcher: createFetcher({ transport: spy, timeoutMs: 5000 }),
        settings: {
          id: "git-content",
          github: { repo, ...(ref ? { ref } : {}) },
          folders: ASTRO_FOLDERS,
        },
      });
    for (const [repo, ref] of [
      ["a/b/c", undefined],
      ["a", undefined],
      ["../x", undefined],
      ["a b/c", undefined],
      ["a/b", "../x"],
      ["a/b", "x?y=1"],
    ] as const)
      await expect(named(repo, ref).types()).rejects.toThrow(/owner\/name/);
    expect(asked).toEqual([]);
  });

  it("more files in a folder than the GitHub bound is could-not-check that points to a local clone", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/content/blog/p${i}.md`] = "---\ntitle: P\n---\n";
    const a = createGitContentAdapter({
      env: {},
      fetcher: createFetcher({ transport: githubTransport(files), timeoutMs: 5000 }),
      now: () => NOW,
      limits: { ...GIT_CONTENT_LIMITS, githubFiles: 5 },
      settings: { id: "git-content", github: { repo: REPO }, folders: ASTRO_FOLDERS },
    });
    await expect(a.types()).rejects.toThrow(/Read a local clone/);
  });
});

describe("the settings and the registry: unit", () => {
  const parse = (entry: object) => adaptersConfigSchema.safeParse({ adapters: [entry] });
  const ok = {
    id: "git-content",
    path: ".",
    folders: { blog: { dir: "src/content/blog", permalink: "/blog/{slug}" } },
  };

  it("takes exactly one of path and github, and needs folders", () => {
    expect(parse(ok).success).toBe(true);
    expect(parse({ ...ok, path: undefined, github: { repo: "a/b", ref: "main" } }).success).toBe(
      true,
    );
    expect(parse({ ...ok, github: { repo: "a/b" } }).success).toBe(false);
    for (const repo of ["../x", "a/..", "./a/b", "a/b/c", "a b/c"])
      expect(parse({ ...ok, path: undefined, github: { repo } }).success, repo).toBe(false);
    expect(parse({ id: "git-content", folders: ok.folders }).success).toBe(false);
    expect(parse({ id: "git-content", path: "." }).success).toBe(false);
    expect(parse({ ...ok, urls: { blog: "/b/{slug}" } }).success).toBe(false);
  });

  it("accepts hyphenated front matter names in fingerprint, and keeps them out of other adapters", () => {
    expect(parse({ ...ok, fingerprint: { blog: ["hero-image"] } }).success).toBe(true);
    expect(parse({ id: "sanity", fingerprint: { post: ["hero-image"] } }).success).toBe(false);
  });

  it("path, github and folders belong to this adapter only", () => {
    expect(parse({ id: "sanity", path: "." }).success).toBe(false);
    expect(parse({ id: "wordpress", folders: ok.folders }).success).toBe(false);
  });

  it("refuses a permalink with a token that does not exist or an address on another scheme", () => {
    expect(parse({ ...ok, folders: { b: { dir: "x", permalink: "/{nope}" } } }).success).toBe(
      false,
    );
    expect(
      parse({ ...ok, folders: { b: { dir: "x", permalink: "http://x.example/{slug}" } } }).success,
    ).toBe(false);
  });

  it("is registered as built, no longer planned, and builds from a settings file", () => {
    expect(BUILT_ADAPTERS.has("git-content")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "git-content")).toBe(false);
    writeTree(dir, ASTRO_FILES);
    const [built] = createAdapters(
      adaptersConfigSchema.parse({
        adapters: [{ ...ok, path: ".", folders: { blog: { dir: "src/content/blog" } } }],
      }),
      { env: {}, fetcher, cwd: dir },
    );
    expect(built?.id).toBe("git-content");
  });

  it("a relative path is read from where the run starts, not from the package", async () => {
    writeTree(dir, ASTRO_FILES);
    const a = createGitContentAdapter({
      env: {},
      fetcher,
      cwd: dir,
      now: () => NOW,
      settings: { id: "git-content", path: ".", folders: ASTRO_FOLDERS },
    });
    expect((await a.types())[0]).toEqual({ name: "blog", count: 3 });
  });
});
