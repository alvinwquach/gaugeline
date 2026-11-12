import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher, type Fetcher } from "../../fetcher.js";
import { anonymousAsk } from "../../delivery/probe.js";
import { createBudget } from "../../limits.js";
import type { CheckContext, Finding } from "../../model.js";
import { PROBING_CHECKS } from "../../presets.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { PAGE_CHECKS, createPageRegistry } from "../index.js";
import { gatedDownloadOpen } from "../gated-download-open.js";

/**
 * gated-download-open (G26a): ask each download route for its file with no session and no
 * purchase, read the first kilobyte, report the routes that hand it over. Tideline Coaching is an
 * invented running coach whose site sells a 7-day plan.
 */

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const PDF = "%PDF-1.7\n%invented plan\n";
const pdf: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/pdf" }).end(`${PDF}${"x".repeat(4000)}`);
};
const status =
  (code: number, headers: Record<string, string> = {}, body = ""): Handler =>
  (_req, res) => {
    res.writeHead(code, { "content-type": "text/plain", ...headers }).end(body);
  };
const loginPage: Handler = (_req, res) => {
  res
    .writeHead(200, { "content-type": "text/html" })
    .end("<!doctype html><html><body><h1>Please sign in</h1></body></html>");
};

const link = (href: string) => `<a href="${href}">link</a>`;

function pageAt(origin: string, hrefs: string[]): PageSnapshot {
  return buildSnapshot([
    {
      url: `${origin}/shop/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Shop</title></head><body>${hrefs.map(link).join("")}</body></html>`,
      ms: 1,
    },
  ]);
}

interface Run {
  found: Finding[];
  notes: { url: string; reason: string }[];
  server: FixtureServer;
  fetcher: Fetcher;
  budget: ReturnType<typeof createBudget>;
}

async function run(
  routes: Record<string, Handler>,
  hrefs: string[],
  extra: Partial<CheckContext> = {},
): Promise<Run> {
  const server = await startServer(routes);
  servers.push(server);
  const fetcher = createFetcher({ allowPrivate: true });
  const budget = createBudget();
  const notes: { url: string; reason: string }[] = [];
  const found = await gatedDownloadOpen.run(pageAt(server.origin, hrefs), {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher,
    budget,
    ownerConsent: true,
    ...extra,
  });
  return { found, notes, server, fetcher, budget };
}

describe("gated-download-open: integration", () => {
  it("a route that answers 200 application/pdf with no session is a finding", async () => {
    const { found, server } = await run({ "/api/download/7-day-plan": pdf }, [
      "/api/download/7-day-plan",
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "gated-download-open",
      severity: "high",
      url: `${server.origin}/api/download/7-day-plan`,
    });
    expect(found[0]?.evidence).toBe(
      "/api/download/7-day-plan -> 200 application/pdf. Asked with no session and no purchase, the route handed over the file.",
    );
  });

  it("a 302 to /login, a 401 and a 403 pass, and the login page is never asked for", async () => {
    const { found, notes, server } = await run(
      {
        "/api/download/members-guide": status(302, {
          location: "/login?next=/api/download/members-guide",
        }),
        "/api/download/class-notes": status(401, {}, "Unauthorised"),
        "/api/export/orders": status(403),
        "/login": loginPage,
      },
      ["/api/download/members-guide", "/api/download/class-notes", "/api/export/orders"],
    );
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
    expect(server.log.map((r) => r.path.split("?")[0]).sort()).toEqual([
      "/api/download/class-notes",
      "/api/download/members-guide",
      "/api/export/orders",
    ]);
  });

  it("a 5 MB response is read for about a kilobyte, then the connection is closed", async () => {
    let written = 0;
    let closed = false;
    const big: Handler = (_req, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.on("close", () => {
        closed = true;
      });
      const chunk = Buffer.alloc(512, 0x78);
      chunk.write("%PDF");
      const timer = setInterval(() => {
        if (closed || written >= 5 * 1024 * 1024) {
          clearInterval(timer);
          if (!closed) res.end();
          return;
        }
        written += chunk.byteLength;
        res.write(chunk);
      }, 20);
    };
    const { found } = await run({ "/api/download/big": big }, ["/api/download/big"]);
    expect(found).toHaveLength(1);
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    // The server was asked for 5 MB and saw the connection close after a few kilobytes.
    expect(written).toBeLessThan(64 * 1024);
  });

  it("the query string is used to ask and never printed", async () => {
    const seen: string[] = [];
    const { found } = await run(
      {
        "/api/download": (req, res) => {
          seen.push(req.url ?? "");
          return pdf(req, res);
        },
      },
      ["/api/download?file=7-day-plan&session=do-not-print-me"],
    );
    expect(seen).toEqual(["/api/download?file=7-day-plan&session=do-not-print-me"]);
    expect(JSON.stringify(found)).not.toContain("do-not-print-me");
    expect(found[0]?.url).not.toContain("?");
  });
});

describe("gated-download-open: edge cases", () => {
  it("200 text/html that says please sign in passes", async () => {
    const { found } = await run({ "/api/download/plan": loginPage }, ["/api/download/plan"]);
    expect(found).toEqual([]);
  });

  it("200 application/octet-stream with an HTML body passes: the bytes win over the header", async () => {
    const { found } = await run(
      {
        "/api/download/plan": (_req, res) => {
          res
            .writeHead(200, { "content-type": "application/octet-stream" })
            .end("<html><body>Sign in to download</body></html>");
        },
      },
      ["/api/download/plan"],
    );
    expect(found).toEqual([]);
  });

  it("a 302 to a signed storage address is followed one hop and reported with a note", async () => {
    const { found, server } = await run(
      {
        "/api/download/plan": status(302, {
          location: "/storage/plan.pdf?Expires=1999999999&Signature=abc123def",
        }),
        "/storage/plan.pdf": pdf,
      },
      ["/api/download/plan"],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      `/api/download/plan -> 302, then 200 application/pdf from ${new URL(server.origin).host}. Asked with no session and no purchase, the route sent the visitor to the file: the signed link was issued without a purchase check.`,
    );
    expect(JSON.stringify(found)).not.toContain("abc123def");
    expect(server.log.map((r) => r.path.split("?")[0])).toEqual([
      "/api/download/plan",
      "/storage/plan.pdf",
    ]);
  });

  it("follows only one hop", async () => {
    const { found, notes, server } = await run(
      {
        "/api/download/plan": status(302, { location: "/hop-two" }),
        "/hop-two": status(302, { location: "/hop-three" }),
        "/hop-three": pdf,
      },
      ["/api/download/plan"],
    );
    expect(found).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      "the route redirected more than once; only one redirect is followed",
    ]);
    expect(server.log.map((r) => r.path)).toEqual(["/api/download/plan", "/hop-two"]);
  });

  it("a dynamic route with no concrete address seen is listed as not probed and never requested", async () => {
    const { found, notes, server } = await run({}, ["/about"], {
      routeFiles: ["app/api/download/[id]/route.ts"],
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([
      {
        url: `${server.origin}/api/download/[id]`,
        reason:
          "not asked: no link on the page gives an address for this dynamic route, and Gaugeline never guesses ids",
      },
    ]);
    expect(server.log).toEqual([]);
  });

  it("a dynamic route is asked for the concrete addresses that links give", async () => {
    const { found, server } = await run({ "/api/download/7-day-plan": pdf }, [
      "/api/download/7-day-plan",
    ]);
    expect(found).toHaveLength(1);
    expect(server.log).toHaveLength(1);
  });

  it("twelve routes found: ten are asked, two are named as skipped", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i));
    const routes: Record<string, Handler> = {};
    for (const id of ids) routes[`/api/download/${id}`] = status(401);
    const { found, notes, server, budget } = await run(
      routes,
      ids.map((id) => `/api/download/${id}`).reverse(),
    );
    expect(found).toEqual([]);
    expect(server.log.map((r) => r.path).sort()).toEqual(
      ids.slice(0, 10).map((id) => `/api/download/${id}`),
    );
    expect(notes.map((n) => new URL(n.url).pathname)).toEqual([
      "/api/download/k",
      "/api/download/l",
    ]);
    expect(notes[0]?.reason).toContain("only the first 10 in sorted order are asked");
    expect(budget.summary().downloadRoutes).toMatchObject({ limit: 10, sampled: 10, found: 12 });
  });

  it("a route that does not answer, or says slow down, is could not check, never a pass", async () => {
    const { found, notes } = await run(
      {
        "/api/download/a": status(429, { "retry-after": "5" }),
        "/api/download/b": status(500),
      },
      ["/api/download/a", "/api/download/b"],
    );
    expect(found).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      "the route asked to be asked less often (429)",
      "the route answered 500, which says nothing about whether it hands the file over",
    ]);
  });

  it("a link to a static file and a link to another site are not routes", async () => {
    const { found, server } = await run({}, [
      "/files/menu.pdf",
      "https://cdn.example/download/plan",
    ]);
    expect(found).toEqual([]);
    expect(server.log).toEqual([]);
  });
});

describe("gated-download-open: a probing check", () => {
  it("is off without owner consent: nothing is asked, and it says why", async () => {
    const { found, notes, server } = await run(
      { "/api/download/plan": pdf },
      ["/api/download/plan"],
      {
        ownerConsent: false,
      },
    );
    expect(found).toEqual([]);
    expect(server.log).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("--owner-consent");
    expect(notes[0]?.reason).toContain("permission to test");
  });

  it("is on the probing list, so a run without consent leaves it out and with consent runs it", async () => {
    expect(PROBING_CHECKS).toEqual([
      "gated-download-open",
      "image-optimizer-open",
      "not-found-200",
      "nuxt-devtools-public",
      "nuxt-preview-public",
    ]);
    expect(PAGE_CHECKS.some((c) => c.id === "gated-download-open")).toBe(true);
    for (const consent of [false, true]) {
      const server = await startServer({
        "/": (_req, res) => {
          res
            .writeHead(200, { "content-type": "text/html" })
            .end(
              `<html><head><title>Tideline</title></head><body>${link("/api/download/plan")}</body></html>`,
            );
        },
        "/api/download/plan": pdf,
      });
      servers.push(server);
      const out = await checkSite({
        address: server.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        registry: createPageRegistry(),
        only: ["gated-download-open"],
        ...(consent ? { ownerConsent: true } : {}),
      });
      expect(out.result.findings.map((f) => f.checkId)).toEqual(
        consent ? ["gated-download-open"] : [],
      );
      expect(out.result.couldNotCheck.map((c) => c.id)).toEqual(
        consent ? [] : ["gated-download-open"],
      );
      expect(server.log.some((r) => r.path.startsWith("/api/"))).toBe(consent);
    }
  });

  it("a default run (no ids asked for, no consent) neither runs nor lists it", async () => {
    const server = await startServer({
      "/": (_req, res) => {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<html><head><title>Tideline</title></head><body>${link("/api/download/plan")}</body></html>`,
          );
      },
      "/api/download/plan": pdf,
    });
    servers.push(server);
    const out = await checkSite({
      address: server.origin,
      fetcher: createFetcher({ allowPrivate: true }),
      registry: createPageRegistry(),
      // Every other check is left out so the run stays small.
      only: PAGE_CHECKS.map((c) => c.id).filter((id) => id !== "gated-download-open"),
    });
    expect(out.result.passed).not.toContain("gated-download-open");
    expect(out.result.couldNotCheck.map((c) => c.id)).not.toContain("gated-download-open");
    // The link and page samplers ask for same-site links on every run. The probe's own request is
    // the one that says it wants no compression, so that is the one that must be missing.
    expect(
      server.log.filter(
        (r) => r.path.startsWith("/api/") && r.headers["accept-encoding"] === "identity",
      ),
    ).toEqual([]);
  });
});

describe("gated-download-open: promise test", () => {
  it("every request is a GET with no cookie, Authorization or Referer, and at most 1,024 bytes of body are read per route", async () => {
    const big: Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      const chunk = Buffer.alloc(1024, 0x41);
      chunk.write("PK\u0003\u0004", "latin1");
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed || n++ > 5000) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write(chunk);
      }, 2);
    };
    const routes: Record<string, Handler> = {
      "/api/download/a": pdf,
      "/api/download/b": big,
      "/api/download/c": status(401),
      "/api/download/d": status(302, { location: "/login" }),
      "/api/download/e": loginPage,
    };
    const { found, server } = await run(routes, Object.keys(routes));
    expect(found.map((f) => f.evidence.split(" ")[0])).toEqual([
      "/api/download/a",
      "/api/download/b",
    ]);
    expect(server.log.length).toBeGreaterThanOrEqual(5);
    for (const r of server.log) {
      expect(r.method).toBe("GET");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.referer).toBeUndefined();
    }
    // The bytes the fetcher read for each route, from the hop itself.
    const fetcher = createFetcher({ allowPrivate: true });
    for (const path of Object.keys(routes)) {
      const hop = (await fetcher.get(`${server.origin}${path}`, anonymousAsk())).at(-1);
      expect(hop?.bytes ?? 0).toBeLessThanOrEqual(1024);
      expect(hop?.body).toBeUndefined();
    }
  });

  it("does not send a protected preview's secret to the route", async () => {
    const server = await startServer({ "/api/download/a": pdf });
    servers.push(server);
    const fetcher = createFetcher({
      allowPrivate: true,
      headersFor: () => ({
        authorization: "Bearer preview-secret",
        "x-vercel-protection-bypass": "s3cret",
      }),
    });
    const found = await gatedDownloadOpen.run(pageAt(server.origin, ["/api/download/a"]), {
      warn: () => undefined,
      fetcher,
      ownerConsent: true,
    });
    expect(found).toHaveLength(1);
    expect(server.log[0]?.headers.authorization).toBeUndefined();
    expect(server.log[0]?.headers["x-vercel-protection-bypass"]).toBeUndefined();
  });
});
