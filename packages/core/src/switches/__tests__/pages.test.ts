import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { createBudget, LIMITS } from "../../limits.js";
import { buildSnapshot } from "../../snapshot.js";
import { createStatePages, pageLanguage, phrasesFor, targetsFor } from "../pages.js";

interface Seen {
  method: string;
  url: string;
}

function site(
  answers: Record<
    string,
    { status?: number; type?: string; body?: string; headers?: Record<string, string> } | "down"
  >,
  seen: Seen[] = [],
) {
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    const a = answers[url.pathname];
    if (a === "down") return Promise.reject(new Error("connect ECONNREFUSED"));
    const { status = 404, type = "text/html", body = "", headers = {} } = a ?? {};
    return Promise.resolve({
      status,
      headers: { "content-type": type, ...headers },
      body: Readable.from([Buffer.from(body, "utf8")]),
    });
  };
  return createFetcher({ transport, timeoutMs: 2000 });
}

const URL = (p: string): string => `https://shop.example${p}`;
const html = (text: string): string =>
  `<!doctype html><html lang="en"><body><p>${text}</p></body></html>`;

describe("createStatePages: reading the pages the file names", () => {
  it("reads a page with GET and gives its snapshot, once however often it is asked for", async () => {
    const seen: Seen[] = [];
    const pages = createStatePages({
      fetcher: site({ "/order": { status: 200, body: html("Order here") } }, seen),
      budget: createBudget(),
    });
    const [a, b] = await Promise.all([pages.get(URL("/order")), pages.get(URL("/order/"))]);
    expect(a.ok && a.page.finalUrl).toBe(URL("/order"));
    expect(b).toBe(a);
    expect(seen).toEqual([{ method: "GET", url: URL("/order") }]);
  });

  it("sends only GET requests, whatever it is asked", async () => {
    const seen: Seen[] = [];
    const pages = createStatePages({
      fetcher: site({ "/a": { status: 200, body: html("a") }, "/b": { status: 404 } }, seen),
      budget: createBudget(),
    });
    await pages.get(URL("/a"));
    await pages.get(URL("/b"));
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
  });

  it("uses a page the run already has instead of asking again", async () => {
    const seen: Seen[] = [];
    const known = buildSnapshot([
      {
        url: URL("/"),
        status: 200,
        headers: { "content-type": "text/html" },
        ms: 1,
        body: html("home"),
      },
    ]);
    const pages = createStatePages({
      fetcher: site({}, seen),
      budget: createBudget(),
      known: [known],
    });
    const got = await pages.get(URL("/"));
    expect(got.ok && got.page).toBe(known);
    expect(seen).toEqual([]);
  });

  it("says why a page could not be read: 404, a refusal, no answer, an error, not a page", async () => {
    const pages = createStatePages({
      fetcher: site({
        "/gone": { status: 404 },
        "/wall": { status: 403 },
        "/down": "down",
        "/broken": { status: 500 },
        "/data": { status: 200, type: "application/json", body: "{}" },
      }),
      budget: createBudget(),
    });
    const kinds = await Promise.all(
      ["/gone", "/wall", "/down", "/broken", "/data"].map(async (p) => {
        const got = await pages.get(URL(p));
        return got.ok ? "ok" : [got.kind, got.message];
      }),
    );
    expect(kinds).toEqual([
      ["gone", "/gone answers 404"],
      ["refused", "/wall refused automated readers (403), so it was not read"],
      ["unreachable", "/down could not be reached"],
      ["unreachable", "/broken answers 500"],
      ["not-html", "/data is not a web page"],
    ]);
  });

  it(`reads at most ${LIMITS.statePages} different pages and says so for the rest`, async () => {
    const answers = Object.fromEntries(
      Array.from({ length: LIMITS.statePages + 2 }, (_, i) => [
        `/p${i}`,
        { status: 200, body: html("x") },
      ]),
    );
    const seen: Seen[] = [];
    const budget = createBudget();
    const pages = createStatePages({ fetcher: site(answers, seen), budget });
    const got = await Promise.all(Object.keys(answers).map((p) => pages.get(URL(p))));
    expect(got.filter((g) => g.ok)).toHaveLength(LIMITS.statePages);
    const last = got.at(-1);
    expect(last && !last.ok && last.kind).toBe("over-limit");
    expect(seen).toHaveLength(LIMITS.statePages);
    expect(budget.summary().statePages).toEqual({
      limit: LIMITS.statePages,
      sampled: LIMITS.statePages,
      found: LIMITS.statePages + 2,
    });
  });
});

describe("targets and phrases for several languages", () => {
  const rules = { prefixes: { en: "/", es: "/es/" }, default: "en" };
  const phrase = { en: "order at the bar", "es-MX": "pida en la barra" };

  it("a single phrase is one target at the path", () => {
    expect(targetsFor("/order", "sold out", "https://shop.example", rules)).toEqual([
      { path: "/order", url: "https://shop.example/order", phrase: "sold out" },
    ]);
  });

  it("a phrase per language becomes one target per language when the site's scheme gives the address", () => {
    expect(
      targetsFor("/order", phrase, "https://shop.example", rules).map((t) => [t.url, t.lang]),
    ).toEqual([
      ["https://shop.example/order", "en"],
      ["https://shop.example/es/order", "es"],
    ]);
  });

  it("with no language scheme there is one target and any phrase will do for an unknown language", () => {
    const [target] = targetsFor("/order", phrase, "https://shop.example", undefined);
    const fr = buildSnapshot([
      {
        url: URL("/order"),
        status: 200,
        headers: { "content-type": "text/html" },
        ms: 1,
        body: "<html lang='fr'></html>",
      },
    ]);
    expect(phrasesFor(target as never, fr, undefined)).toEqual([
      "order at the bar",
      "pida en la barra",
    ]);
  });

  it("the page's own language picks the phrase; es-MX and es are the same language", () => {
    const [target] = targetsFor("/order", phrase, "https://shop.example", undefined);
    const es = buildSnapshot([
      {
        url: URL("/order"),
        status: 200,
        headers: { "content-type": "text/html" },
        ms: 1,
        body: "<html lang='es-US'></html>",
      },
    ]);
    expect(pageLanguage(es, undefined)).toBe("es");
    expect(phrasesFor(target as never, es, undefined)).toEqual(["pida en la barra"]);
  });

  it("with no html lang the address gives the language under the site's scheme", () => {
    const page = buildSnapshot([
      {
        url: URL("/es/order"),
        status: 200,
        headers: { "content-type": "text/html" },
        ms: 1,
        body: "<html></html>",
      },
    ]);
    expect(pageLanguage(page, rules)).toBe("es");
    expect(pageLanguage(page, undefined)).toBeUndefined();
  });
});
