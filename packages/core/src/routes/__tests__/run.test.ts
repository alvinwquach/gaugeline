import { fileURLToPath } from "node:url";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRoutesRegistry,
  routeHiddenNotProtected,
} from "../../checks/route-hidden-not-protected.js";
import { createFetcher } from "../../fetcher.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { checkRoutes } from "../run.js";
import { AUTH_PAGE, PAGE, cleanUpRepos, repo } from "./helpers.js";

cleanUpRepos();

const APP = fileURLToPath(new URL("../../../../fixtures/app-routes/", import.meta.url));
const NOW = new Date("2026-11-10T09:00:00Z");

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function site(): Promise<Fixture> {
  const s = await startFixture("app-routes");
  closers.push(() => s.close());
  return s;
}

async function run(
  dir: string,
  base: string,
  extra: { ownerConsent?: boolean; prefix?: string } = {},
) {
  return checkRoutes({
    dir,
    base,
    fetcher: createFetcher({ allowPrivate: true }),
    now: NOW,
    ownerConsent: extra.ownerConsent ?? true,
    ...(extra.prefix === undefined ? {} : { prefix: extra.prefix }),
  });
}

describe("route-hidden-not-protected: integration (Fernbank Physio, four routes)", () => {
  it("exactly one finding, on the route that reads the session and renders anyway, naming its file", async () => {
    const fixture = await site();
    const { result, routes, answers, skipped } = await run(APP, fixture.origin);
    expect(routes.map((r) => [r.path, r.expectsSession])).toEqual([
      ["/", false],
      ["/account/invoices", true],
      ["/account/payments", true],
      ["/appointments", true],
    ]);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding).toMatchObject({
      checkId: "route-hidden-not-protected",
      severity: "high",
      title: "/account/invoices is handed over with no session",
      url: `${fixture.origin}/account/invoices`,
    });
    expect(finding?.evidence).toBe(
      "/account/invoices answered 200 with 127 bytes to a request with no session, no cookie and no token. Your code expects a session here (the page calls auth()). File: app/account/invoices/page.tsx.",
    );
    expect(Object.fromEntries([...answers].map(([p, a]) => [p, a.result]))).toEqual({
      "/appointments": "redirected-to-login",
      "/account/payments": "refused",
      "/account/invoices": "handed-over",
    });
    expect(skipped).toEqual([]);
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
    // The public page and the login page the redirect names are never asked.
    expect([...fixture.hits.keys()].sort()).toEqual([
      "/account/invoices",
      "/account/payments",
      "/appointments",
    ]);
  });

  it("the file names are as typed from the command: a prefix goes in front", async () => {
    const fixture = await site();
    const { result } = await run(APP, fixture.origin, { prefix: "packages/fixtures/app-routes" });
    expect(result.findings[0]?.evidence).toContain(
      "File: packages/fixtures/app-routes/app/account/invoices/page.tsx.",
    );
  });

  it("without consent nothing is asked and the check says why", async () => {
    const fixture = await site();
    const { result, answers } = await run(APP, fixture.origin, { ownerConsent: false });
    expect(result.findings).toEqual([]);
    expect(fixture.total).toBe(0);
    expect(answers.size).toBe(0);
    expect(result.couldNotCheck).toEqual([
      {
        id: "route-hidden-not-protected",
        url: fixture.origin,
        reason: expect.stringContaining("only with --owner-consent"),
      },
    ]);
  });

  it("a folder with no app directory asks nothing", async () => {
    const fixture = await site();
    const { result, appDir } = await run(repo({ "lib/x.ts": "" }), fixture.origin);
    expect(appDir).toBeUndefined();
    expect(result.findings).toEqual([]);
    expect(fixture.total).toBe(0);
  });

  it("the check is in its own registry, as a high check in Security & email", () => {
    expect(
      createRoutesRegistry()
        .all()
        .map((c) => [c.id, c.severity, c.area]),
    ).toEqual([["route-hidden-not-protected", "high", "Security & email"]]);
    expect(routeHiddenNotProtected.tech).toContain("at most 30");
  });
});

const html =
  (body: string): Handler =>
  (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  };

describe("route-hidden-not-protected: edge cases", () => {
  async function ask(files: Record<string, string>, routes: Record<string, Handler>) {
    const server: FixtureServer = await startServer(routes);
    closers.push(() => server.close());
    return { server, ...(await run(repo(files), server.origin)) };
  }

  it("a 200 whose body is the login form is not a finding", async () => {
    const { result } = await ask(
      { "app/account/page.tsx": AUTH_PAGE },
      { "/account": html('<form><input type="email"><input type="password"></form>') },
    );
    expect(result.findings).toEqual([]);
  });

  it("a route that returns 200 with an empty body is low, and says it responds with nothing", async () => {
    const { result } = await ask(
      { "app/account/page.tsx": AUTH_PAGE },
      { "/account": (_req, res) => void res.writeHead(200).end() },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "low",
      title: "/account responds with nothing",
    });
    expect(result.findings[0]?.evidence).toContain("empty body");
    expect(result.findings[0]?.evidence).toContain("File: app/account/page.tsx.");
  });

  it("a dynamic guarded route is listed as not probed: needs a real id", async () => {
    const { result, server } = await ask(
      { "app/orders/[id]/page.tsx": AUTH_PAGE, "app/page.tsx": PAGE },
      {},
    );
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck).toEqual([
      {
        id: "route-hidden-not-protected",
        url: "/orders/[id]",
        reason: "not probed: needs a real id",
      },
    ]);
    expect(server.log).toHaveLength(0);
  });

  it("45 guarded routes: 30 asked, 15 listed as skipped, and the ones that hand over are found among the 30", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 45; i++) files[`app/r${String(i).padStart(2, "0")}/page.tsx`] = AUTH_PAGE;
    const { result, server } = await ask(files, {
      "/r07": html("<h1>open</h1>"),
      "/r40": html("<h1>open</h1>"),
    });
    expect(server.log).toHaveLength(30);
    expect(result.findings.map((f) => f.title)).toEqual(["/r07 is handed over with no session"]);
    expect(result.couldNotCheck).toHaveLength(15);
    expect(result.couldNotCheck[0]?.reason).toContain("not probed: more than 30 routes");
  });

  it("a route that answers 500 is could not check, never a pass and never a finding", async () => {
    const { result } = await ask(
      { "app/account/page.tsx": AUTH_PAGE },
      { "/account": (_req, res) => void res.writeHead(500).end("boom") },
    );
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck).toEqual([
      expect.objectContaining({ id: "route-hidden-not-protected", url: "/account" }),
    ]);
    expect(result.couldNotCheck[0]?.reason).toContain("500");
  });

  it("a route name with invisible characters is escaped in the finding", async () => {
    const dir = repo({ ["app/ac​count/page.tsx"]: AUTH_PAGE });
    const server = await startServer({}, html("<h1>open</h1>"));
    closers.push(() => server.close());
    const { result } = await run(dir, server.origin);
    expect(result.findings[0]?.title).toBe("/ac\\u{200B}count is handed over with no session");
    expect(result.findings[0]?.evidence).toContain("File: app/ac\\u{200B}count/page.tsx.");
  });
});

describe("the fixture site", () => {
  it("serves four routes and the tests never write to it", async () => {
    const fixture = await site();
    expect(SITES_DIR.length).toBeGreaterThan(0);
    await run(APP, fixture.origin);
    expect([...fixture.methods.keys()]).toEqual(["GET"]);
  });
});
