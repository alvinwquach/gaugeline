import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { createWordPress } from "../reader.js";
import { ROUTES, usersJson, wpPage, wpWorld, type SiteDef } from "./world.js";

const HOST = "harbour-bar.example";
const ROOT = `https://${HOST}/wp-json/`;

function reader(sites: Record<string, SiteDef> = {}, wporg = {}) {
  const world = wpWorld(sites, wporg);
  return {
    wp: createWordPress(createFetcher({ transport: world.transport, timeoutMs: 5000 })),
    seen: world.seen,
  };
}

describe("the wordpress.org reader", () => {
  it("reads the current WordPress release from the first offer", async () => {
    expect(await reader().wp.latest("core")).toEqual({ ok: true, version: "6.8.3" });
  });

  it("reads a plugin's and a theme's current version by slug, with GET, no key and nothing sent", async () => {
    const { wp, seen } = reader();
    expect(await wp.latest("plugin", "easy-booking")).toEqual({ ok: true, version: "2.4.0" });
    expect(await wp.latest("theme", "twenty-twenty-four")).toEqual({ ok: true, version: "1.3" });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=easy-booking",
      "GET https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=twenty-twenty-four",
    ]);
  });

  it("a slug the directory does not list is unlisted, for a plugin (404) and for a theme (200 with an error)", async () => {
    const { wp } = reader();
    expect(await wp.latest("plugin", "cellar-club")).toMatchObject({ ok: false, unlisted: true });
    expect(await wp.latest("theme", "harbour-child")).toMatchObject({ ok: false, unlisted: true });
  });

  it("asks each address once per run", async () => {
    const { wp, seen } = reader();
    await Promise.all([wp.latest("core"), wp.latest("core"), wp.latest("plugin", "gallery-lite")]);
    await wp.latest("plugin", "gallery-lite");
    expect(seen).toHaveLength(2);
  });

  it("a slug that is not a plugin name is never put in an address", async () => {
    const { wp, seen } = reader();
    for (const slug of ["", "../x", "a b", "A;rm", "x".repeat(81)])
      expect((await wp.latest("plugin", slug)).ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("an answer with no readable version is could-not-know, not unlisted", async () => {
    const { wp } = reader({}, { core: { offers: [{ current: "next" }] } });
    const got = await wp.latest("core");
    expect(got).toMatchObject({ ok: false });
    expect((got as { unlisted?: true }).unlisted).toBeUndefined();
  });

  it("wordpress.org unreachable is a reason, not a throw", async () => {
    const got = await reader({}, { down: true }).wp.latest("core");
    expect(got).toMatchObject({ ok: false });
    expect((got as { reason: string }).reason).toContain("api.wordpress.org");
  });
});

describe("the users reader", () => {
  it("a list of users is exposed, and only their id is asked for", async () => {
    const { wp, seen } = reader({ [HOST]: { routes: ROUTES.usersOpen } });
    expect(await wp.users(ROOT)).toEqual({
      ok: true,
      exposed: true,
      listed: 2,
      route: "/wp-json/wp/v2/users?per_page=100&_fields=id",
    });
    expect(seen).toEqual([
      { method: "GET", url: `https://${HOST}/wp-json/wp/v2/users?per_page=100&_fields=id` },
    ]);
  });

  it("the total WordPress reports counts, not only the first page", async () => {
    const site: SiteDef = {
      routes: {
        "/wp-json/wp/v2/users": {
          body: usersJson(3),
          type: "application/json",
        },
      },
      headers: { "x-wp-total": "140" },
    };
    expect(await reader({ [HOST]: site }).wp.users(ROOT)).toMatchObject({
      exposed: true,
      listed: 140,
    });
  });

  it("a 401 or 403 is not exposed", async () => {
    expect(await reader({ [HOST]: { routes: ROUTES.usersClosed } }).wp.users(ROOT)).toMatchObject({
      ok: true,
      exposed: false,
    });
    const forbidden: SiteDef = {
      routes: { "/wp-json/wp/v2/users": { status: 403, body: "{}", type: "application/json" } },
    };
    expect(await reader({ [HOST]: forbidden }).wp.users(ROOT)).toMatchObject({ exposed: false });
  });

  it("an empty list is not exposed", async () => {
    const empty: SiteDef = {
      routes: { "/wp-json/wp/v2/users": { body: "[]", type: "application/json" } },
    };
    expect(await reader({ [HOST]: empty }).wp.users(ROOT)).toMatchObject({
      ok: true,
      exposed: false,
    });
  });

  it("plain permalinks: /wp-json/ is 404, so the /?rest_route= form is asked, and a list there is exposed", async () => {
    const plain: SiteDef = {
      routes: {
        "/?rest_route=%2Fwp%2Fv2%2Fusers&per_page=100&_fields=id": {
          body: usersJson(1),
          type: "application/json",
        },
      },
    };
    const { wp, seen } = reader({ [HOST]: plain });
    expect(await wp.users(ROOT)).toMatchObject({ ok: true, exposed: true, listed: 1 });
    expect(seen).toHaveLength(2);
  });

  it("the REST API off in both forms is not exposed", async () => {
    expect(await reader({ [HOST]: { routes: {} } }).wp.users(ROOT)).toMatchObject({
      ok: true,
      exposed: false,
    });
  });

  it("a server error, a rate limit or a page that is not a list is could-not-check, never not-exposed", async () => {
    const answer = (status: number, body: string): SiteDef => ({
      routes: { "/wp-json/wp/v2/users": { status, body, type: "application/json" } },
    });
    for (const site of [
      answer(503, "{}"),
      answer(429, "{}"),
      answer(200, '{"code":"x"}'),
      answer(200, "<html>"),
    ])
      expect(await reader({ [HOST]: site }).wp.users(ROOT)).toMatchObject({ ok: false });
  });

  it("a host that does not answer is could-not-check", async () => {
    expect(await reader({}).wp.users(ROOT)).toMatchObject({ ok: false });
  });

  it("is asked once per root", async () => {
    const { wp, seen } = reader({ [HOST]: { routes: ROUTES.usersOpen } });
    await wp.users(ROOT);
    await wp.users(ROOT);
    expect(seen).toHaveLength(1);
  });
});

describe("claim", () => {
  it("is true the first time and false after", () => {
    const { wp } = reader();
    expect([wp.claim("a"), wp.claim("a"), wp.claim("b")]).toEqual([true, false, true]);
  });
});

it("the page helper makes a page the reader's signs recognise", () => {
  expect(wpPage({ plugins: [["easy-booking", "2.1.3"]] })).toContain(
    "/wp-content/plugins/easy-booking/css/style.css?ver=2.1.3",
  );
});
