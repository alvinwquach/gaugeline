import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { hashValue } from "../fingerprint.js";
import { AdapterCouldNotCheck } from "../types.js";
import type { AdapterSettings } from "../types.js";
import {
  WORDPRESS_COUNT_CAP,
  WORDPRESS_DESCRIPTION,
  createWordPressAdapter,
  type WordPressAdapter,
} from "../wordpress.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import { WP_ENV, WP_USER } from "./entries.js";
import {
  CONTENT_MARKERS,
  COPPER_LANTERN,
  wordpressTransport,
  type Item,
  type WordPressFixtureOptions,
} from "./wordpress-fixture.js";

const KEY = WP_ENV.WORDPRESS_APP_PASSWORD;
const APP = { user: WP_USER, password: KEY };

interface Build {
  content?: Item[];
  fixture?: WordPressFixtureOptions;
  env?: Record<string, string | undefined>;
  settings?: AdapterSettings;
  pageSize?: number;
}

function build(b: Build = {}): { adapter: WordPressAdapter; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(wordpressTransport(b.content, { app: APP, ...(b.fixture ?? {}) }), seen),
    timeoutMs: 5000,
  });
  const adapter = createWordPressAdapter({
    env: b.env ?? WP_ENV,
    fetcher,
    settings: b.settings,
    sleep: () => Promise.resolve(),
    ...(b.pageSize ? { pageSize: b.pageSize } : {}),
  });
  return { adapter, seen };
}

const reasonOf = async (run: () => Promise<unknown>): Promise<string> => {
  const err: unknown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

describe("WordPress: what it says about itself", () => {
  it("is a scoped key kind: WordPress has no read-only key, and published content needs none", () => {
    expect(WORDPRESS_DESCRIPTION).toEqual({
      name: "WordPress",
      docsUrl: "https://gaugeline.dev/docs/integrations/wordpress",
      keyKind: "scoped",
    });
  });
});

describe("WordPress: a healthy site, read with no key for what is published", () => {
  it("lists content types and leaves out media, blocks and a type another plugin serves elsewhere", async () => {
    const { adapter } = build();
    expect((await adapter.types()).map((t) => t.name)).toEqual(["event", "page", "post"]);
  });

  it("asks for what is published with no Authorization header at all", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    await collectPublished(adapter, { fields: { post: ["title"] } });
    await adapter.fieldCounts("post", ["title"]);
    expect(seen.length).toBeGreaterThan(5);
    for (const s of seen) expect(s.headers.authorization).toBeUndefined();
    expect(requestProblems(seen)).toEqual([]);
  });

  it("gives ids, slugs, paths, times and hashes of the fields the settings name, and no text", async () => {
    const { adapter } = build({
      settings: { id: "wordpress", fingerprint: { post: ["title", "excerpt"] } },
    });
    const { docs } = await collectPublished(adapter, { types: ["post"] });
    expect(docs).toEqual([
      {
        id: "11",
        type: "post",
        url: "/news/autumn-cocktails/",
        slug: "autumn-cocktails",
        publishedAt: "2026-11-01T08:00:00.000Z",
        updatedAt: "2026-11-03T14:30:00.000Z",
        fieldHashes: {
          title: hashValue(CONTENT_MARKERS.autumn),
          excerpt: hashValue("<p>Seven new drinks.</p>"),
        },
      },
      expect.objectContaining({
        id: "12",
        fieldHashes: { title: hashValue(CONTENT_MARKERS.happyHour) },
      }),
      expect.objectContaining({ id: "13" }),
    ]);
    expect(JSON.stringify(docs)).not.toContain(CONTENT_MARKERS.autumn);
  });

  it("with no fields named, the request names none of them", async () => {
    const { adapter, seen } = build();
    await collectPublished(adapter, { types: ["post"] });
    const asked = decodeURIComponent(seen.map((s) => s.url).join("\n"));
    expect(asked).toContain("_fields=id,slug,link,date_gmt,modified_gmt");
    expect(asked).not.toMatch(/_fields=[^&\n]*(title|content|excerpt)/);
  });

  it("an Elementor-built page is a page like any other: its rendered markup is hashed, never kept", async () => {
    const { adapter } = build({
      settings: { id: "wordpress", fingerprint: { page: ["content"] } },
    });
    const { docs } = await collectPublished(adapter, { types: ["page"] });
    expect(docs.map((d) => d.id)).toEqual(["21", "22", "23"]);
    expect(docs[0]?.fieldHashes.content).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(docs)).not.toContain("elementor");
  });

  it("the settings' address template wins over the permalink (a headless front end)", async () => {
    const { adapter } = build({
      settings: { id: "wordpress", urls: { post: "/blog/{slug}" } },
    });
    const { docs } = await collectPublished(adapter, { types: ["post"] });
    expect(docs.map((d) => d.url)).toEqual([
      "/blog/autumn-cocktails",
      "/blog/happy-hour",
      "/blog/private-hire",
    ]);
  });

  it("reads page after page by the headers WordPress sends, and stops at the limit", async () => {
    const { adapter, seen } = build({ pageSize: 2 });
    const all = await collectPublished(adapter, { types: ["post"] });
    expect(all.docs.map((d) => d.id)).toEqual(["11", "12", "13"]);
    expect(seen.filter((s) => s.url.includes("/posts?")).length).toBe(2);
    const some = await collectPublished(build({ pageSize: 2 }).adapter, { limit: 4 });
    expect(some.docs.map((d) => d.id)).toEqual(["31", "32", "21", "22"]);
  });

  it("since: asks the server, and drops older items the server did not filter", async () => {
    const { adapter, seen } = build();
    const { docs } = await collectPublished(adapter, { types: ["post"], since: "2026-10-01" });
    expect(docs.map((d) => d.id)).toEqual(["11", "12"]);
    expect(decodeURIComponent(seen.map((s) => s.url).join("\n"))).toContain(
      "modified_after=2026-10-01T00:00:00.000Z",
    );
    // A server that ignores modified_after (an old WordPress): the same answer from the filter made here.
    const content = COPPER_LANTERN.map((i) => i);
    const ignoring = createFetcher({
      transport: (url, req) => {
        url.searchParams.delete("modified_after");
        return wordpressTransport(content, { app: APP })(url, req);
      },
      timeoutMs: 5000,
    });
    const old = createWordPressAdapter({ env: WP_ENV, fetcher: ignoring });
    expect(
      (await collectPublished(old, { types: ["post"], since: "2026-10-01" })).docs.map((d) => d.id),
    ).toEqual(["11", "12"]);
  });

  it("a type the site does not list gives nothing, and fieldCounts for it gives zeros", async () => {
    const { adapter } = build();
    expect((await collectPublished(adapter, { types: ["booking"] })).docs).toEqual([]);
    expect(await adapter.fieldCounts("booking", ["title"])).toEqual({ title: 0 });
  });

  it("counts a field by its text: an empty excerpt and a missing one are no value", async () => {
    const { adapter } = build();
    expect(await adapter.fieldCounts("post", ["title", "excerpt", "content.rendered"])).toEqual({
      title: 3,
      excerpt: 2,
      "content.rendered": 3,
    });
    expect(await adapter.fieldCounts("page", ["excerpt", "featured_media"])).toEqual({
      excerpt: 2,
      featured_media: 0,
    });
  });

  it("works for a site installed in a folder", async () => {
    const { adapter, seen } = build({
      fixture: { root: "/club" },
      env: { ...WP_ENV, WORDPRESS_URL: "https://copper-lantern.example/club/" },
    });
    expect((await adapter.types()).length).toBe(3);
    expect(seen[0]?.url).toBe("https://copper-lantern.example/club/wp-json/wp/v2/types");
  });

  it("more items than it counts field by field: could-not-check, never a partial count", async () => {
    const many: Item[] = Array.from({ length: WORDPRESS_COUNT_CAP + 1 }, (_, i) => ({
      ...(COPPER_LANTERN[0] as Item),
      id: 1000 + i,
    }));
    const reason = await reasonOf(() =>
      build({ content: many }).adapter.fieldCounts("post", ["title"]),
    );
    expect(reason).toContain("more than");
  }, 30_000);
});

describe("WordPress: drift between the CMS and the page", () => {
  /** What the live page shows for each post, by slug: the heading, as text. */
  const PAGE: Record<string, string> = {
    "autumn-cocktails": CONTENT_MARKERS.autumn,
    "happy-hour": CONTENT_MARKERS.happyHour,
    "private-hire": CONTENT_MARKERS.hire,
  };

  async function drifted(content: Item[]): Promise<string[]> {
    const { adapter } = build({
      content,
      settings: { id: "wordpress", fingerprint: { post: ["title"] } },
    });
    const { docs } = await collectPublished(adapter, { types: ["post"] });
    return docs
      .filter((d) => d.fieldHashes.title !== hashValue(PAGE[d.slug ?? ""]))
      .map((d) => d.slug ?? "");
  }

  it("healthy: every title the CMS holds is the one the page shows", async () => {
    expect(await drifted(COPPER_LANTERN)).toEqual([]);
  });

  it("drift: a title edited in the CMS after the page was built no longer matches, and only that one", async () => {
    const edited = COPPER_LANTERN.map((i) =>
      i.id === 12
        ? {
            ...i,
            title: { rendered: "Happy hour moves to six" },
            modified_gmt: "2026-11-09T10:00:00",
          }
        : i,
    );
    expect(await drifted(edited)).toEqual(["happy-hour"]);
  });
});

describe("WordPress: a key that may not read part of it", () => {
  it("a subscriber's key: published content still reads, drafts and members are could-not-check, and the key is never shown", async () => {
    const { adapter } = build({ fixture: { role: "subscriber" } });
    expect((await adapter.types()).length).toBe(3);
    expect((await collectPublished(adapter, { types: ["post"] })).docs).toHaveLength(3);
    for (const call of [
      () => adapter.draftsReachable(),
      () => adapter.members?.() ?? Promise.reject(new Error("no members")),
    ]) {
      const reason = await reasonOf(call);
      expect(reason).toContain("may not read this (HTTP 403)");
      expect(reason).not.toContain(KEY);
    }
  });

  it("a contributor's key lists drafts of posts even though pages refuse it", async () => {
    const { adapter } = build({ fixture: { role: "contributor" } });
    expect(await adapter.draftsReachable()).toBe(true);
  });

  it("a key that sees no drafts says false, not could-not-check", async () => {
    const published = COPPER_LANTERN.filter((i) => i.status === "publish");
    expect(await build({ content: published }).adapter.draftsReachable()).toBe(false);
  });

  it("no key set: drafts and members are could-not-check naming the variables, and no request carries a key", async () => {
    const { adapter, seen } = build({ env: { WORDPRESS_URL: WP_ENV.WORDPRESS_URL } });
    expect((await adapter.types()).length).toBe(3);
    const reason = await reasonOf(() => adapter.draftsReachable());
    expect(reason).toContain("WORDPRESS_USER");
    expect(reason).toContain("WORDPRESS_APP_PASSWORD");
    expect(await reasonOf(() => adapter.members?.() ?? Promise.resolve())).toContain("not set");
    for (const s of seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("a wrong password: could-not-check, with the password blanked wherever it could appear", async () => {
    const { adapter } = build({ fixture: { app: { user: WP_USER, password: "something-else" } } });
    const reason = await reasonOf(() => adapter.draftsReachable());
    expect(reason).toContain("did not accept the application password");
    expect(reason).not.toContain(KEY);
  });

  it("an http address: the password is not sent over plain http", async () => {
    const { adapter, seen } = build({
      env: { ...WP_ENV, WORDPRESS_URL: "http://copper-lantern.example" },
    });
    expect(await reasonOf(() => adapter.draftsReachable())).toContain("not sent over plain http");
    expect(seen).toEqual([]);
  });

  it("an application password typed with the spaces WordPress shows is still blanked", async () => {
    const spaced = "abcd efgh ijkl mnop";
    const { adapter } = build({
      env: { ...WP_ENV, WORDPRESS_APP_PASSWORD: spaced },
      fixture: { app: { user: WP_USER, password: "other" } },
    });
    const reason = await reasonOf(() => adapter.draftsReachable());
    expect(reason).not.toMatch(/abcd|efgh|ijkl|mnop/);
  });

  it("the REST API turned off: could-not-check with what to look at, never an empty list", async () => {
    const reason = await reasonOf(() => build({ fixture: { restOff: true } }).adapter.types());
    expect(reason).toContain("HTTP 404");
    expect(reason).toContain("permalinks");
  });

  it("a security plugin that refuses visitors: could-not-check that says visitors are refused", async () => {
    const reason = await reasonOf(() =>
      build({ fixture: { visitorsRefused: true } }).adapter.types(),
    );
    expect(reason).toContain("refused an anonymous read");
  });

  it("no address, or one that is not an address, is could-not-check naming WORDPRESS_URL", async () => {
    expect(await reasonOf(() => build({ env: {} }).adapter.types())).toContain(
      "WORDPRESS_URL is not set",
    );
    expect(
      await reasonOf(() => build({ env: { WORDPRESS_URL: "not an address" } }).adapter.types()),
    ).toContain("not an address");
    const withLogin = new URL("https://copper-lantern.example");
    withLogin.username = "someone";
    withLogin.password = "secret";
    expect(
      await reasonOf(() => build({ env: { WORDPRESS_URL: withLogin.href } }).adapter.types()),
    ).toContain("no user name or password");
  });
});

describe("WordPress: what is installed (for gaugeline advisory)", () => {
  it("lists active plugins and the active theme with their versions, and leaves inactive ones out", async () => {
    expect(await build().adapter.installed()).toEqual({
      plugins: [
        { slug: "easy-booking", version: "2.1.3" },
        { slug: "elementor", version: "3.19.0" },
        { slug: "hello", version: "1.7.2" },
      ],
      themes: [{ slug: "harbour-child", version: "1.0.4" }],
    });
  });

  it("only an administrator may list them: anyone else is could-not-check, and no cheaper key is asked for it", async () => {
    const reason = await reasonOf(() => build({ fixture: { role: "editor" } }).adapter.installed());
    expect(reason).toContain("HTTP 403");
    const { adapter, seen } = build({ env: { WORDPRESS_URL: WP_ENV.WORDPRESS_URL } });
    await reasonOf(() => adapter.installed());
    expect(seen).toEqual([]);
  });
});

describe("WordPress: members", () => {
  it("shows the highest role a user holds, and an address WordPress did not give as such", async () => {
    const { adapter } = build();
    const got = await adapter.members?.();
    expect(got?.map((m) => m.role)).toEqual(["admin", "member", "viewer"]);
    expect(JSON.stringify(got)).not.toContain("Rosa");
  });
});
