import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import {
  createWordPress,
  type Latest,
  type UsersRead,
  type WordPress,
} from "../../wordpress/reader.js";
import { addWordPressChecks } from "../../wordpress/registry.js";
import { ROUTES, wpPage, wpWorld, type SiteDef } from "../../wordpress/__tests__/world.js";
import { createPageRegistry } from "../index.js";
import { WORDPRESS_CHECKS, restRootOf, wpOutdated, wpUsersExposed } from "../wordpress.js";
import { page } from "./helpers.js";

const BAR = "harbour-bar.example";

/** A page whose one hop carries this HTML, as the check reads it. */
const pageOf = (html: string, host = BAR) =>
  page({
    finalUrl: `https://${host}/`,
    hops: [
      {
        url: `https://${host}/`,
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
        ms: 1,
      },
    ],
  });

interface Fake {
  latest?: Record<string, Latest>;
  users?: UsersRead;
}

function fake(f: Fake = {}): WordPress & { asked: string[] } {
  const asked: string[] = [];
  const claimed = new Set<string>();
  const spent = new Map<string, number>();
  return {
    asked,
    latest: async (kind, slug = "") => {
      asked.push(`${kind}:${slug}`);
      return (
        f.latest?.[`${kind}:${slug}`] ?? {
          ok: false,
          unlisted: true,
          reason: `the ${kind} ${slug} is not in the wordpress.org directory`,
        }
      );
    },
    users: async () => f.users ?? { ok: true, exposed: false, listed: 0, route: "/x" },
    claim: (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
    reserve: (kind) => {
      const used = (spent.get(kind) ?? 0) + 1;
      spent.set(kind, used);
      return used <= 15;
    },
  };
}

function context(wordpress?: WordPress) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(wordpress ? { wordpress } : {}),
  };
  return { ctx, notes };
}

const ok = (version: string): Latest => ({ ok: true, version });
const CURRENT: Record<string, Latest> = {
  "core:wordpress": ok("6.8.3"),
  "plugin:easy-booking": ok("2.4.0"),
  "plugin:gallery-lite": ok("1.3.0"),
};

describe("the WordPress checks: unit", () => {
  it("there are two, both medium", () => {
    expect(WORDPRESS_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["wp-outdated", "medium"],
      ["wp-users-exposed", "medium"],
    ]);
  });

  it("do nothing without --wordpress: no finding, no note", async () => {
    const { ctx, notes } = context();
    const p = pageOf(wpPage({ plugins: [["easy-booking", "2.1.3"]] }));
    expect(await wpOutdated.run(p, ctx)).toEqual([]);
    expect(await wpUsersExposed.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("skip a page that is not WordPress, and ask nothing about it", async () => {
    const wp = fake();
    const { ctx, notes } = context(wp);
    const p = pageOf("<!doctype html><title>Plain</title><h1>A site with no CMS</h1>");
    expect(await wpOutdated.run(p, ctx)).toEqual([]);
    expect(await wpUsersExposed.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([]);
    expect(wp.asked).toEqual([]);
  });
});

describe("wp-outdated: positive and negative", () => {
  const shown = (over: Parameters<typeof wpPage>[0] = {}) =>
    pageOf(
      wpPage({
        generator: "WordPress 6.2.1",
        plugins: [
          ["easy-booking", "2.1.3"],
          ["gallery-lite", "1.3.0"],
        ],
        ...over,
      }),
    );

  it("positive: names each component older than the current release, with both numbers, and no other", async () => {
    const { ctx, notes } = context(fake({ latest: CURRENT }));
    const out = await wpOutdated.run(shown(), ctx);
    expect(out.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
      [
        "wp-outdated",
        "medium",
        "The page declares WordPress 6.2.1 (read from the generator tag); the current release in the wordpress.org API is 6.8.3.",
      ],
      [
        "wp-outdated",
        "medium",
        "The page declares the plugin easy-booking 2.1.3 (read from the ?ver= on its files on this page); the current release in the wordpress.org directory is 2.4.0.",
      ],
    ]);
    expect(out[0]?.url).toBe(`https://${BAR}/`);
    expect(notes).toEqual([]);
  });

  it("negative: everything on its current release is no finding and no note", async () => {
    const { ctx, notes } = context(fake({ latest: CURRENT }));
    const p = shown({
      generator: "WordPress 6.8.3",
      plugins: [
        ["easy-booking", "2.4.0"],
        ["gallery-lite", "1.3.0"],
      ],
    });
    expect(await wpOutdated.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("compares whole numbers in parts: 5.8 is older than 5.10, and 5.10 is not older than 5.8", async () => {
    const latest = { ...CURRENT, "plugin:table-chairs": ok("5.10") };
    const old = context(fake({ latest }));
    expect(
      (
        await wpOutdated.run(
          shown({ generator: "WordPress 6.8.3", plugins: [["table-chairs", "5.8"]] }),
          old.ctx,
        )
      ).map((f) => f.evidence),
    ).toEqual([expect.stringContaining("table-chairs 5.8")]);
    const newer = context(fake({ latest: { ...CURRENT, "plugin:table-chairs": ok("5.8") } }));
    expect(
      await wpOutdated.run(
        shown({ generator: "WordPress 6.8.3", plugins: [["table-chairs", "5.10"]] }),
        newer.ctx,
      ),
    ).toEqual([]);
  });

  describe("versions read from ver= strings", () => {
    const run = async (ver: string | null) => {
      const { ctx, notes } = context(fake({ latest: CURRENT }));
      const out = await wpOutdated.run(
        pageOf(wpPage({ generator: "WordPress 6.8.3", plugins: [["easy-booking", ver]] })),
        ctx,
      );
      return { out, notes };
    };

    it("a release number is a version: 2.1.3, 5.8, 1.0.0-beta2", async () => {
      for (const ver of ["2.1.3", "1.0", "1.0.0-beta2"])
        expect((await run(ver)).out.map((f) => f.checkId)).toEqual(["wp-outdated"]);
    });

    it("a date, a hash, a timestamp or a build id is a cache-buster: could-not-check, never a version and never a finding", async () => {
      for (const ver of ["20231105", "2023.11.05", "8f3a2c1", "1700000000", "build-77"]) {
        const { out, notes } = await run(ver);
        expect(out, ver).toEqual([]);
        expect(
          notes.map((n) => n.reason),
          ver,
        ).toEqual([expect.stringContaining("no version Gaugeline can read (plugin easy-booking)")]);
      }
    });

    it("files with no ?ver= at all are the same: could-not-check", async () => {
      const { out, notes } = await run(null);
      expect(out).toEqual([]);
      expect(notes).toHaveLength(1);
    });

    it("WordPress's own number on a plugin's files is not the plugin's version", async () => {
      // 6.8.3 is the core number: with it on the plugin's files, the plugin's version is not known.
      const { out, notes } = await run("6.8.3");
      expect(out).toEqual([]);
      expect(notes[0]?.reason).toContain("no version Gaugeline can read");
    });

    it("two different numbers on one plugin's files: could-not-check, the plugin's own number is not known", async () => {
      const { ctx, notes } = context(fake({ latest: CURRENT }));
      const html = wpPage({
        generator: "WordPress 6.8.3",
        plugins: [["easy-booking", "2.1.3"]],
      }).replace(
        "</head>",
        '<link rel="stylesheet" href="/wp-content/plugins/easy-booking/includes/x.css?ver=9.9.1"></head>',
      );
      expect(await wpOutdated.run(pageOf(html), ctx)).toEqual([]);
      expect(notes[0]?.reason).toContain("more than one version number");
      expect(notes[0]?.reason).toContain("easy-booking (2.1.3, 9.9.1)");
    });
  });

  describe("a site that hides its versions", () => {
    it("no generator tag and no versioned core file: could-not-check, not up to date, and no finding", async () => {
      const wp = fake({ latest: CURRENT });
      const { ctx, notes } = context(wp);
      const hidden = pageOf(
        wpPage({ generator: null, plugins: [["easy-booking", null]], coreVer: null }),
      );
      expect(await wpOutdated.run(hidden, ctx)).toEqual([]);
      expect(notes.map((n) => n.reason)).toEqual([
        expect.stringContaining("shows no version"),
        expect.stringContaining("no version Gaugeline can read (plugin easy-booking)"),
      ]);
      expect(notes[0]?.reason).toContain("That is not the same as up to date.");
      // Nothing was looked up for a version that is not there.
      expect(wp.asked).toEqual([]);
    });

    it("the core version from the files under wp-includes is used when the generator tag is gone", async () => {
      const { ctx, notes } = context(fake({ latest: CURRENT }));
      const p = pageOf(wpPage({ generator: null, coreVer: "6.2.1" }));
      const out = await wpOutdated.run(p, ctx);
      expect(out[0]?.evidence).toContain(
        "The page declares WordPress 6.2.1 (read from the version on the site's wp-includes files)",
      );
      expect(notes).toEqual([]);
    });
  });

  it("a premium or custom plugin that wordpress.org does not list is one could-not-check line, not a pass", async () => {
    const { ctx, notes } = context(fake({ latest: CURRENT }));
    const p = pageOf(
      wpPage({
        generator: "WordPress 6.8.3",
        plugins: [
          ["table-booker-pro", "3.0.1"],
          ["cellar-club", "1.2.0"],
        ],
        themes: [["harbour-child", "1.0.4"]],
      }),
    );
    expect(await wpOutdated.run(p, ctx)).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      expect.stringContaining(
        "3 components are not in the wordpress.org directory (plugin table-booker-pro, plugin cellar-club, theme harbour-child)",
      ),
    ]);
  });

  it("wordpress.org that cannot be reached is could-not-check for each component, never a pass", async () => {
    const { ctx, notes } = context(
      fake({
        latest: {
          "core:wordpress": {
            ok: false,
            reason:
              "https://api.wordpress.org could not be read: connect ECONNREFUSED, so the current WordPress release is not known.",
          },
        },
      }),
    );
    expect(await wpOutdated.run(pageOf(wpPage({ generator: "WordPress 6.2.1" })), ctx)).toEqual([]);
    expect(notes[0]?.reason).toContain("was not compared");
  });

  it("a version that is not a version on either side is could-not-check", async () => {
    const { ctx } = context(fake({ latest: { "core:wordpress": ok("6.8.3") } }));
    const p = pageOf(wpPage({ generator: "WordPress 6.2.1" }));
    expect((await wpOutdated.run(p, ctx)).length).toBe(1);
    const odd = context(fake({ latest: { "core:wordpress": ok("trunk") as Latest } }));
    expect(await wpOutdated.run(p, odd.ctx)).toEqual([]);
    expect(odd.notes[0]?.reason).toContain("could not compare them");
  });

  it("each component is reported once per run, on the first page that shows it", async () => {
    const { ctx } = context(fake({ latest: CURRENT }));
    const first = await wpOutdated.run(
      pageOf(wpPage({ plugins: [["easy-booking", "2.1.3"]] })),
      ctx,
    );
    const second = await wpOutdated.run(
      pageOf(wpPage({ plugins: [["easy-booking", "2.1.3"]] })),
      ctx,
    );
    expect(first).toHaveLength(2);
    expect(second).toEqual([]);
  });

  it("looks up at most 15 plugins for the whole run, not for each page, and says how many were left", async () => {
    const many = (from: number) =>
      Array.from({ length: 10 }, (_, i): [string, string] => [`plugin-${from + i}`, "1.0.0"]);
    const wp = fake({ latest: CURRENT });
    const { ctx, notes } = context(wp);
    for (const from of [0, 10])
      await wpOutdated.run(
        pageOf(wpPage({ generator: "WordPress 6.8.3", plugins: many(from) })),
        ctx,
      );
    expect(wp.asked.filter((a) => a.startsWith("plugin:"))).toHaveLength(15);
    expect(
      notes.filter((n) => /not compared: at most 15/.test(n.reason)).map((n) => n.reason),
    ).toEqual([
      expect.stringContaining(
        "5 plugins were not compared: at most 15 plugins are looked up in a run",
      ),
    ]);
  });

  describe("a ?ver= is the plugin's version only on the plugin's own files", () => {
    const withExtra = (extra: string, own: string | null = null) =>
      pageOf(
        wpPage({ generator: "WordPress 6.8.3", plugins: [["easy-booking", own]] }).replace(
          "</head>",
          `${extra}</head>`,
        ),
      );
    const bundled = (file: string, ver: string) =>
      `<link rel="stylesheet" href="/wp-content/plugins/easy-booking/${file}?ver=${ver}">`;

    it("a bundled library's number is not the plugin's: could-not-check, never outdated", async () => {
      for (const file of [
        "vendor/fontawesome/css/all.css",
        "assets/lib/slick/slick.css",
        "fonts/font-awesome.min.css",
        "css/bootstrap.min.css",
        "node_modules/swiper/swiper.css",
      ]) {
        const { ctx, notes } = context(fake({ latest: CURRENT }));
        expect(await wpOutdated.run(withExtra(bundled(file, "5.15.4")), ctx), file).toEqual([]);
        expect(notes[0]?.reason, file).toContain(
          "no version Gaugeline can read (plugin easy-booking)",
        );
      }
    });

    it("its own file's number is used, and a bundled library's beside it is ignored", async () => {
      const { ctx, notes } = context(fake({ latest: CURRENT }));
      const out = await wpOutdated.run(
        withExtra(bundled("vendor/fontawesome/css/all.css", "5.15.4"), "2.1.3"),
        ctx,
      );
      expect(out.map((f) => f.evidence)).toEqual([expect.stringContaining("easy-booking 2.1.3")]);
      expect(notes).toEqual([]);
    });
  });

  it("a version newer than the directory's current release is could-not-check, not current", async () => {
    const { ctx, notes } = context(fake({ latest: CURRENT }));
    const out = await wpOutdated.run(
      pageOf(wpPage({ generator: "WordPress 6.8.3", plugins: [["easy-booking", "9.9.1"]] })),
      ctx,
    );
    expect(out).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      expect.stringContaining("declares 9.9.1, which is newer than the current release 2.4.0"),
    ]);
  });
});

describe("wp-users-exposed: positive and negative", () => {
  const p = pageOf(wpPage({}));

  it("positive: a list of users to a visitor is a finding with the count and no names", async () => {
    const { ctx, notes } = context(
      fake({
        users: {
          ok: true,
          exposed: true,
          listed: 2,
          route: "/wp-json/wp/v2/users?per_page=100&_fields=id",
        },
      }),
    );
    const out = await wpUsersExposed.run(p, ctx);
    expect(out).toEqual([
      {
        checkId: "wp-users-exposed",
        severity: "medium",
        title: "The site's REST API lists its users to anyone",
        evidence:
          "GET /wp-json/wp/v2/users?per_page=100&_fields=id with no login listed 2 users. Only the count was read; no name or slug was asked for or kept.",
        url: `https://${BAR}/`,
      },
    ]);
    expect(notes).toEqual([]);
  });

  it("negative: not exposed is no finding and no note", async () => {
    const { ctx, notes } = context(
      fake({ users: { ok: true, exposed: false, listed: 0, route: "/x" } }),
    );
    expect(await wpUsersExposed.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a read that failed is could-not-check, never a pass", async () => {
    const { ctx, notes } = context(
      fake({ users: { ok: false, reason: "The users route answered HTTP 503." } }),
    );
    expect(await wpUsersExposed.run(p, ctx)).toEqual([]);
    expect(notes[0]?.reason).toBe(
      "The users route answered HTTP 503. Whether the site lists its users was not checked.",
    );
  });

  it("asks once per site in a run", async () => {
    const { ctx } = context(fake({ users: { ok: true, exposed: true, listed: 1, route: "/x" } }));
    expect(await wpUsersExposed.run(p, ctx)).toHaveLength(1);
    expect(await wpUsersExposed.run(p, ctx)).toEqual([]);
  });
});

describe("the REST root a page names", () => {
  it("is the api.w.org link when it is on the page's own site (a WordPress in a folder)", () => {
    const html =
      '<link rel="https://api.w.org/" href="https://harbour-bar.example/club/wp-json/" />';
    expect(restRootOf(html, "https://harbour-bar.example/club/")).toBe(
      "https://harbour-bar.example/club/wp-json/",
    );
    expect(
      restRootOf(
        "<link href='/blog/wp-json/' rel='https://api.w.org/'>",
        "https://harbour-bar.example/blog/x",
      ),
    ).toBe("https://harbour-bar.example/blog/wp-json/");
  });

  it("is /wp-json/ on the page's own origin when the page names none, or names another host", () => {
    expect(restRootOf("<p>no link</p>", "https://harbour-bar.example/a/b")).toBe(
      "https://harbour-bar.example/wp-json/",
    );
    expect(
      restRootOf(
        '<link rel="https://api.w.org/" href="https://elsewhere.example/wp-json/">',
        "https://harbour-bar.example/",
      ),
    ).toBe("https://harbour-bar.example/wp-json/");
  });
});

describe("the WordPress checks over invented sites: integration", () => {
  const HARBOUR: SiteDef = {
    routes: {
      "/": wpPage({
        generator: "WordPress 6.2.1",
        plugins: [
          ["easy-booking", "2.1.3"],
          ["gallery-lite", "1.3.0"],
          ["cellar-club", "1.2.0"],
        ],
        themes: [["harbour-child", "1.0.4"]],
      }),
      ...ROUTES.usersOpen,
    },
  };
  const CLINIC: SiteDef = {
    // A hardened clinic site: no generator tag, no versions on files, users closed.
    routes: {
      "/": wpPage({ generator: null, plugins: [["easy-booking", null]], coreVer: null }),
      ...ROUTES.usersClosed,
    },
  };

  async function runOn(host: string, sites: Record<string, SiteDef>, wporg = {}, off = false) {
    const world = wpWorld(sites, wporg);
    const fetcher = createFetcher({ transport: world.transport, timeoutMs: 5000 });
    const registry = off ? createPageRegistry() : addWordPressChecks(createPageRegistry());
    const { result } = await checkSite({
      address: `https://${host}/`,
      fetcher,
      registry,
      only: WORDPRESS_CHECKS.map((c) => c.id).filter((id) => registry.has(id)),
      ...(off ? {} : { wordpress: createWordPress(fetcher) }),
    });
    return { result, seen: world.seen };
  }

  it("a site behind on updates with its users listed: both findings, and the premium plugin is could-not-check", async () => {
    const { result } = await runOn(BAR, { [BAR]: HARBOUR });
    expect(result.findings.map((f) => f.checkId).sort()).toEqual([
      "wp-outdated",
      "wp-outdated",
      "wp-users-exposed",
    ]);
    expect(result.findings.find((f) => f.checkId === "wp-users-exposed")?.evidence).toContain(
      "listed 2 users",
    );
    expect(result.couldNotCheck.map((c) => c.reason)).toEqual([
      expect.stringContaining(
        "2 components are not in the wordpress.org directory (plugin cellar-club, theme harbour-child)",
      ),
    ]);
    expect(result.passed).not.toContain("wp-outdated");
  });

  it("a hardened site that hides its versions and closes its users: no finding, and could-not-check for the versions", async () => {
    const { result } = await runOn("lantern-clinic.example", { "lantern-clinic.example": CLINIC });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.every((c) => c.id === "wp-outdated")).toBe(true);
    expect(result.couldNotCheck.length).toBeGreaterThanOrEqual(2);
    expect(result.passed).toContain("wp-users-exposed");
    expect(result.passed).not.toContain("wp-outdated");
  });

  it("every request is a GET, goes to the site or to api.wordpress.org, and only the id of a user is asked for", async () => {
    const { seen } = await runOn(BAR, { [BAR]: HARBOUR });
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(
      seen.every(
        (s) => new URL(s.url).hostname === BAR || new URL(s.url).hostname === "api.wordpress.org",
      ),
    ).toBe(true);
    const users = seen.filter((s) => s.url.includes("/users"));
    expect(users.map((s) => s.url)).toEqual([
      `https://${BAR}/wp-json/wp/v2/users?per_page=100&_fields=id`,
    ]);
    expect(seen.some((s) => /xmlrpc|wp-login|wp-admin/.test(s.url))).toBe(false);
  });

  it("is not in a run without --wordpress: no finding and no request to wordpress.org or the users route", async () => {
    const { result, seen } = await runOn(BAR, { [BAR]: HARBOUR }, {}, true);
    expect(result.findings).toEqual([]);
    expect(seen.some((s) => s.url.includes("api.wordpress.org") || s.url.includes("/users"))).toBe(
      false,
    );
  });

  it("wordpress.org down: the versions are could-not-check and the users check still runs", async () => {
    const { result } = await runOn(BAR, { [BAR]: HARBOUR }, { down: true });
    expect(result.findings.map((f) => f.checkId)).toEqual(["wp-users-exposed"]);
    expect(result.couldNotCheck.some((c) => c.reason.includes("was not compared"))).toBe(true);
  });

  it("gives the same findings on a second run", async () => {
    const a = await runOn(BAR, { [BAR]: HARBOUR });
    const b = await runOn(BAR, { [BAR]: HARBOUR });
    expect(b.result.findings).toEqual(a.result.findings);
    expect(b.result.couldNotCheck).toEqual(a.result.couldNotCheck);
  });
});
