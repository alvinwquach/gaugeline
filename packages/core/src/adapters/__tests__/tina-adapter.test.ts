import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { hashValue } from "../fingerprint.js";
import { GIT_CONTENT_TOKEN } from "../git-content.entry.js";
import { GIT_CONTENT_LIMITS } from "../git-content-source-read.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, adapterEnvVars, createAdapters } from "../registry.js";
import { TINACLOUD_NOT_READ, createTinaAdapter } from "../tina.js";
import { TINA_TOKEN } from "../tina.entry.js";
import { AdapterCouldNotCheck, type AdapterSettings } from "../types.js";
import { REPO, githubTransport, removeTree, writeTree } from "./git-content-fixture.js";
import { TINA_CONFIG, TINA_FILES, TINA_MARKERS, TINA_NOW } from "./tina-fixture.js";

/**
 * What is particular to the TinaCMS adapter: the collections come from tina/config.ts (read as text), a
 * collection's `match` and `format` pick its files, `ui.router` gives its addresses, and a config that cannot
 * be read is could-not-check. The rules every adapter shares are in the contract suite (tina.contract.ts).
 */
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-tina-")));
});
afterEach(() => removeTree(dir));

const never: Transport = () => Promise.reject(new Error("a local read makes no request"));
const fetcher = createFetcher({ transport: never, timeoutMs: 5000 });
const noWait = () => Promise.resolve();

function local(
  files: Readonly<Record<string, string>>,
  extra: Partial<AdapterSettings> = {},
  over: { limits?: typeof GIT_CONTENT_LIMITS } = {},
) {
  writeTree(dir, files);
  return createTinaAdapter({
    env: {},
    fetcher,
    cwd: dir,
    now: () => TINA_NOW,
    settings: { id: "tina", path: ".", ...extra },
    ...over,
  });
}

const withConfig = (collections: string, extra: Record<string, string> = {}) => ({
  "tina/config.ts": `export default defineConfig({ schema: { collections: ${collections} } });`,
  ...extra,
});

describe("the TinaCMS adapter: a local clone", () => {
  it("reads the collections from tina/config.ts, with drafts, match and format applied", async () => {
    const adapter = local(TINA_FILES);
    expect(await adapter.types()).toEqual([
      { name: "bread", count: 2 },
      { name: "page", count: 2 },
      { name: "post", count: 2 },
    ]);
    const { docs, partial } = await collectPublished(adapter);
    expect(partial).toBeUndefined();
    expect(docs.map((d) => [d.type, d.id])).toEqual([
      ["bread", "content/bread/cardamom-bun.md"],
      ["bread", "content/bread/dark-rye.md"],
      ["page", "content/pages/home.json"],
      ["page", "content/pages/hours.json"],
      ["post", "content/posts/saturday-hours.mdx"],
      ["post", "content/posts/sourdough-class.mdx"],
    ]);
    // The draft, the .md file in an mdx collection, the folder match excludes, the file match leaves out and package.json are not items.
    const ids = docs.map((d) => d.id).join(" ");
    for (const left of ["christmas-orders", "readme", "retired", "draft-page", "package.json"])
      expect(ids).not.toContain(left);
    expect(await adapter.draftsReachable()).toBe("not-applicable");
  });

  it("gives each item the address ui.router names: a file name, a custom slug field, a page's own name", async () => {
    const { docs } = await collectPublished(local(TINA_FILES));
    expect(docs.map((d) => [d.id.split("/").at(-1), d.url])).toEqual([
      ["cardamom-bun.md", "/bread/cardamom-bun"],
      ["dark-rye.md", "/bread/rye"],
      ["home.json", "/home"],
      ["hours.json", "/hours"],
      ["saturday-hours.mdx", "/news/saturday-hours"],
      ["sourdough-class.mdx", "/news/sourdough-class"],
    ]);
  });

  it("hashes only the fields the settings name, and no value leaves the adapter", async () => {
    const adapter = local(TINA_FILES, { fingerprint: { post: ["title", "summary"] } });
    const { docs } = await collectPublished(adapter, { types: ["post"] });
    const one = docs.find((d) => d.id.endsWith("sourdough-class.mdx"));
    expect(one?.fieldHashes).toEqual({
      title: hashValue(TINA_MARKERS.newsOne),
      summary: hashValue("Two spaces left in December."),
    });
    expect(docs.find((d) => d.id.endsWith("saturday-hours.mdx"))?.fieldHashes).toEqual({
      title: hashValue(TINA_MARKERS.newsTwo),
    });
    const everything = JSON.stringify([
      docs,
      await adapter.types(),
      await adapter.fieldCounts("post", ["title", "summary", "subtitle"]),
      await adapter.notRead(),
      adapter.unread(),
    ]);
    for (const marker of Object.values(TINA_MARKERS)) expect(everything).not.toContain(marker);
    expect(await adapter.fieldCounts("post", ["title", "summary", "subtitle"])).toEqual({
      title: 2,
      summary: 1,
      subtitle: 0,
    });
    expect(await adapter.fieldCounts("nothing", ["title"])).toEqual({ title: 0 });
  });

  it("a site with no fingerprint settings reads no field value into a hash", async () => {
    const { docs } = await collectPublished(local(TINA_FILES));
    for (const d of docs) expect(d.fieldHashes).toEqual({});
  });

  it("a missing tina/config.ts is could-not-check, with the reason, and never a pass", async () => {
    const files = { ...TINA_FILES };
    delete files["tina/config.ts"];
    const adapter = local(files);
    for (const call of [
      () => adapter.types(),
      () => adapter.fieldCounts("post", ["title"]),
      () => collectPublished(adapter),
    ]) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterCouldNotCheck);
      expect((err as AdapterCouldNotCheck).reason).toMatch(/no tina\/config\.ts/i);
    }
  });

  it("finds config.js, config.tsx and config.jsx too", async () => {
    for (const name of ["config.js", "config.tsx", "config.jsx"]) {
      const files = { ...TINA_FILES };
      delete files["tina/config.ts"];
      const root = mkdtempSync(path.join(dir, "site-"));
      writeTree(root, { ...files, [`tina/${name}`]: TINA_CONFIG });
      const adapter = createTinaAdapter({
        env: {},
        fetcher,
        cwd: root,
        now: () => TINA_NOW,
        settings: { id: "tina", path: "." },
      });
      expect((await adapter.types()).map((t) => t.name)).toEqual(["bread", "page", "post"]);
    }
  });

  it("a config that cannot be read statically is could-not-check, with the reason and no text from it", async () => {
    const adapter = local({
      "tina/config.ts":
        "import { collections } from './collections';\nexport default defineConfig({ schema: { collections } });",
      "content/posts/a.md": "---\ntitle: A\n---\n",
    });
    const err = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toMatch(
      /no `collections: \[ \.\.\. \]` list written out/,
    );
    expect((err as AdapterCouldNotCheck).reason).toMatch(/not run/);
  });

  it("when no collection can be read, the reason is the first collection's", async () => {
    const adapter = local(withConfig("[postCollection]"));
    await expect(adapter.types()).rejects.toThrow(/not written out in tina\/config\.ts/);
  });

  it("reads what it can and reports the rest: one collection written elsewhere", async () => {
    const adapter = local(
      withConfig(`[postCollection, { name: "page", path: "content/pages", format: "json" }]`, {
        "content/pages/home.json": '{"headline":"h"}',
      }),
    );
    expect(await adapter.types()).toEqual([{ name: "page", count: 1 }]);
    expect(await adapter.notRead()).toEqual([
      expect.objectContaining({ name: "collection 1", kind: "collection" }),
    ]);
  });

  it("folders named by hand replace the config's, and stand in for a config that cannot be read", async () => {
    const adapter = local(
      withConfig("[postCollection]", {
        "content/news/a.md": "---\ntitle: A\n---\n",
        "content/news/b.mdx": "---\ntitle: B\n---\n",
      }),
      { folders: { news: { dir: "content/news", permalink: "/n/{slug}" } } },
    );
    const { docs } = await collectPublished(adapter);
    // By hand there is no format or match filter: the folder is read as a folder.
    expect(docs.map((d) => [d.type, d.url])).toEqual([
      ["news", "/n/a"],
      ["news", "/n/b"],
    ]);
    expect((await adapter.notRead()).map((n) => n.name)).toEqual(["collection 1"]);
  });

  it("folders named by hand work with no tina/config.ts at all", async () => {
    const adapter = local(
      { "content/news/a.md": "---\ntitle: A\n---\n" },
      { folders: { news: { dir: "content/news" } } },
    );
    expect(await adapter.types()).toEqual([{ name: "news", count: 1 }]);
  });

  it("a name by hand replaces the same name in the config, with its own address", async () => {
    const adapter = local(TINA_FILES, {
      folders: { post: { dir: "content/posts", permalink: "/blog/{slug}" } },
    });
    const { docs } = await collectPublished(adapter, { types: ["post"] });
    expect(docs.map((d) => d.url)).toEqual(["/blog/saturday-hours", "/blog/sourdough-class"]);
  });

  it("a collection named like an Object method is an ordinary collection", async () => {
    const adapter = local(
      withConfig(
        `[{ name: "constructor", path: "content/a", format: "md" }, { name: "toString", path: "content/b", format: "mdx" }]`,
        { "content/a/x.md": "---\ntitle: X\n---\n", "content/b/y.mdx": "---\ntitle: Y\n---\n" },
      ),
      { folders: { hasOwnProperty: { dir: "content/a" } } },
    );
    expect(await adapter.types()).toEqual([
      { name: "constructor", count: 1 },
      { name: "hasOwnProperty", count: 1 },
      { name: "toString", count: 1 },
    ]);
  });

  it("reports TinaCloud as not read when the config names a client, and makes no request", async () => {
    const adapter = local(TINA_FILES);
    expect(await adapter.notRead()).toEqual([
      expect.objectContaining({ name: "TinaCloud", reason: TINACLOUD_NOT_READ }),
    ]);
    const without = local(
      withConfig(`[{ name: "a", path: "content/a" }]`, {
        "content/a/x.md": "---\ntitle: X\n---\n",
      }),
    );
    expect(await without.notRead()).toEqual([]);
  });

  it("a ui.router that is too clever gives the items no address and says so", async () => {
    const adapter = local(
      withConfig(
        '[{ name: "a", path: "content/a", ui: { router: ({ document }) => document.x ? "/y" : "/z" } }]',
        { "content/a/x.md": "---\ntitle: X\n---\n" },
      ),
    );
    const { docs } = await collectPublished(adapter);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.url).toBeUndefined();
    expect(await adapter.notRead()).toEqual([
      expect.objectContaining({ name: "a", kind: "address" }),
    ]);
  });

  it("reports content files it could not read, as git-content does (broken front matter, a draft is not one)", async () => {
    const adapter = local({
      ...TINA_FILES,
      "content/posts/broken.mdx": "---\ntitle: [unclosed\n---\n",
    });
    await collectPublished(adapter, { types: ["post"] });
    expect(adapter.unread().total).toBe(1);
    expect(adapter.unread().files[0]?.path).toBe("content/posts/broken.mdx");
  });

  it("a collection folder that is missing is could-not-check for the run", async () => {
    const adapter = local(withConfig(`[{ name: "a", path: "content/missing" }]`));
    await expect(adapter.types()).rejects.toThrow(/does not exist/);
  });

  it("a hidden or parent folder named in the config is refused, not read", async () => {
    for (const p of ["../outside", ".git", "content/.private", "/etc"]) {
      const adapter = local(withConfig(`[{ name: "a", path: "${p}" }]`));
      await expect(adapter.types()).rejects.toBeInstanceOf(AdapterCouldNotCheck);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a link: tina/config.ts as a link, or the tina folder as a link, is not read",
    async () => {
      const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-tina-out-")));
      try {
        writeTree(outside, { "config.ts": TINA_CONFIG });
        // The file is a link.
        const a = path.join(dir, "a");
        mkdirSync(path.join(a, "tina"), { recursive: true });
        symlinkSync(path.join(outside, "config.ts"), path.join(a, "tina", "config.ts"));
        const one = createTinaAdapter({
          env: {},
          fetcher,
          cwd: a,
          settings: { id: "tina", path: "." },
        });
        await expect(one.types()).rejects.toThrow(/no tina\/config\.ts/i);
        // The folder is a link.
        const b = path.join(dir, "b");
        mkdirSync(b, { recursive: true });
        symlinkSync(outside, path.join(b, "tina"));
        const two = createTinaAdapter({
          env: {},
          fetcher,
          cwd: b,
          settings: { id: "tina", path: "." },
        });
        await expect(two.types()).rejects.toBeInstanceOf(AdapterCouldNotCheck);
      } finally {
        removeTree(outside);
      }
    },
  );

  it("a tina/config.ts over the size bound is not read", async () => {
    const adapter = local(
      { "tina/config.ts": TINA_CONFIG },
      {},
      {
        limits: { ...GIT_CONTENT_LIMITS, fileBytes: 100 },
      },
    );
    await expect(adapter.types()).rejects.toThrow(/could not be read as a plain file/);
  });

  it("a config with a symbolic name in it is never run: a require of a missing module does nothing", async () => {
    writeFileSync(path.join(dir, "marker.txt"), "");
    const adapter = local(
      withConfig(`[{ name: "a", path: "content/a" }]`, {
        "content/a/x.md": "---\ntitle: X\n---\n",
        "tina/extra.ts": "require('node:fs').writeFileSync('ran.txt', 'x')",
      }),
    );
    await adapter.types();
    expect(() => realpathSync(path.join(dir, "ran.txt"))).toThrow();
  });
});

describe("the TinaCMS adapter: a repository on GitHub", () => {
  it("reads the config and the content over GET to api.github.com only, with the token in a header", async () => {
    const seen: Array<{ method: string; host: string; url: string; auth: string | undefined }> = [];
    const token = "test-token-" + "z".repeat(12);
    const adapter = createTinaAdapter({
      env: { GAUGELINE_GITHUB_TOKEN: token },
      fetcher: createFetcher({
        transport: githubTransport(TINA_FILES, {
          token,
          onRequest: (method, url, headers) =>
            seen.push({ method, host: url.host, url: url.href, auth: headers.authorization }),
        }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
      now: () => TINA_NOW,
      settings: { id: "tina", github: { repo: REPO } },
    });
    const { docs } = await collectPublished(adapter);
    expect(docs).toHaveLength(6);
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(new Set(seen.map((s) => s.host))).toEqual(new Set(["api.github.com"]));
    expect(seen.every((s) => s.auth === `Bearer ${token}`)).toBe(true);
    expect(seen.every((s) => !s.url.includes(token))).toBe(true);
    // One tree is read for the whole run: the config and every collection share it.
    expect(seen.filter((s) => s.url.includes("/git/trees/"))).toHaveLength(1);
    expect(JSON.stringify([docs, await adapter.notRead()])).not.toContain(token);
  });

  it("with no token the request carries none", async () => {
    const auth: Array<string | undefined> = [];
    const adapter = createTinaAdapter({
      env: {},
      fetcher: createFetcher({
        transport: githubTransport(TINA_FILES, {
          onRequest: (_m, _u, headers) => auth.push(headers.authorization),
        }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
      settings: { id: "tina", github: { repo: REPO } },
    });
    await adapter.types();
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((a) => a === undefined)).toBe(true);
  });

  it("a repository with no tina/config.ts is could-not-check", async () => {
    const files = { ...TINA_FILES };
    delete files["tina/config.ts"];
    const adapter = createTinaAdapter({
      env: {},
      fetcher: createFetcher({ transport: githubTransport(files), timeoutMs: 5000 }),
      sleep: noWait,
      settings: { id: "tina", github: { repo: REPO } },
    });
    await expect(adapter.types()).rejects.toThrow(/no tina\/config\.ts/i);
  });

  it("a collection folder that is missing from the repository is could-not-check, not zero items", async () => {
    const files = {
      ...TINA_FILES,
      "tina/config.ts": `export default defineConfig({ schema: { collections: [{ name: "a", path: "content/missing" }] } });`,
    };
    const adapter = createTinaAdapter({
      env: {},
      fetcher: createFetcher({ transport: githubTransport(files), timeoutMs: 5000 }),
      sleep: noWait,
      settings: { id: "tina", github: { repo: REPO } },
    });
    await expect(adapter.types()).rejects.toThrow(/does not exist/);
  });

  it("a repository that is not found is could-not-check, with GitHub's answer in plain words", async () => {
    const adapter = createTinaAdapter({
      env: {},
      fetcher: createFetcher({
        transport: githubTransport(TINA_FILES, { repo: "someone/else" }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
      settings: { id: "tina", github: { repo: REPO } },
    });
    await expect(adapter.types()).rejects.toThrow(/HTTP 404/);
  });

  it("the settings need path or github", async () => {
    const adapter = createTinaAdapter({ env: {}, fetcher, settings: { id: "tina" } });
    await expect(adapter.types()).rejects.toThrow(/needs "path"/);
    expect(
      await createTinaAdapter({ env: {}, fetcher, settings: undefined })
        .types()
        .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? "could-not-check" : "other")),
    ).toBe("could-not-check");
  });
});

describe("the TinaCMS adapter: where it is registered", () => {
  it("is built, with one entry, and its planned entry is gone", () => {
    expect(BUILT_ADAPTERS.has("tina")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "tina")).toBe(false);
    expect(BUILT_ADAPTERS.get("tina")?.describe).toMatchObject({
      name: "TinaCMS",
      keyKind: "read-only",
    });
  });

  it("reads the same token variable as git-content, and no TinaCloud variable", () => {
    expect(TINA_TOKEN).toBe(GIT_CONTENT_TOKEN);
    expect(adapterEnvVars("tina")).toEqual([TINA_TOKEN]);
    expect(adapterEnvVars("tina").join(" ")).not.toMatch(/TINA_?(TOKEN|CLIENT)/i);
  });

  it("a settings file for it needs path or github, and folders are optional", () => {
    const ok = (e: Record<string, unknown>) =>
      adaptersConfigSchema.safeParse({ adapters: [{ id: "tina", ...e }] }).success;
    expect(ok({ path: "." })).toBe(true);
    expect(ok({ github: { repo: "a/b" } })).toBe(true);
    expect(
      ok({ path: ".", folders: { post: { dir: "content/posts", permalink: "/p/{slug}" } } }),
    ).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ path: ".", github: { repo: "a/b" } })).toBe(false);
    expect(ok({ path: ".", urls: { post: "/p/{slug}" } })).toBe(false);
    // git-content still needs its folders.
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "git-content", path: "." }] }).success,
    ).toBe(false);
  });

  it("is made by the registry with the same settings", async () => {
    writeTree(dir, TINA_FILES);
    const [adapter] = await createAdapters(
      { adapters: [{ id: "tina", path: "." }] },
      { env: {}, fetcher, cwd: dir },
    );
    expect((await adapter?.types())?.map((t) => t.name)).toEqual(["bread", "page", "post"]);
  });
});
