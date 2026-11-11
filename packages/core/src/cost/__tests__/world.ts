import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import type { Seen } from "../../renewals/__tests__/recorded.js";

/**
 * The invented world the cost tests and docs run in, answered from recorded responses (nothing touches a
 * network). Marlowe Bar, an invented bar on Next.js and Vercel, on 11 Nov 2026:
 *  - / is the home page: it carries a new nonce on every visit and nothing else changes, and Vercel's
 *    cache answers MISS the first time and HIT after.
 *  - /specials prints the time it was made, so it is new on every visit.
 *  - /menu is marked static and is rebuilt every second (s-maxage=1).
 *  - /events is marked static and every answer is a MISS.
 * Its Vercel usage is the last fifteen days of the invented account's billing charges.
 */
export const NOW = new Date("2026-11-11T09:00:00Z");

/** An invented key, built at run time so no key-shaped string sits in the repository. */
export const VERCEL_TOKEN = ["vercel", "-invented-", "token", "cost0001"].join("");
export const SANITY_TOKEN = ["sk", "INVENTED", "sanity", "cost0002"].join("");
export const ENV = { NO_COLOR: "1", GAUGELINE_VERCEL_TOKEN: VERCEL_TOKEN };

/** gaugeline.cost.json for the bar. */
export const BAR_CONFIG = {
  static: ["/", "/menu", "/events"],
  pages: ["/specials", "/menu", "/events"],
  vercel: { teamId: "team_harbour01" },
};

export const CHARGES_URL =
  "https://api.vercel.com/v1/billing/charges?from=2026-10-27T00%3A00%3A00.000Z&to=2026-11-11T00%3A00%3A00.000Z";
export const CHARGES_URL_TEAM = `${CHARGES_URL}&teamId=team_harbour01`;

const dayOf = (offset: number): string => {
  const d = new Date(Date.UTC(2026, 9, 27 + offset));
  return d.toISOString().slice(0, 10);
};

interface ChargeSpec {
  service: string;
  unit: string;
  /** Per day, from 27 Oct to 10 Nov: a number for every day, or a function of the day's index (0 to 14). */
  quantity: number | ((i: number) => number);
  cost: number | ((i: number) => number);
}

/** The billing charges for 27 Oct to 10 Nov, one JSON object per line, as FOCUS rows. */
export function chargesBody(specs: readonly ChargeSpec[]): string {
  const lines: string[] = [];
  for (let i = 0; i < 15; i++)
    for (const s of specs) {
      const q = typeof s.quantity === "function" ? s.quantity(i) : s.quantity;
      const c = typeof s.cost === "function" ? s.cost(i) : s.cost;
      lines.push(
        JSON.stringify({
          ServiceName: s.service,
          ConsumedQuantity: q,
          ConsumedUnit: s.unit,
          BilledCost: c,
          BillingCurrency: "USD",
          ChargePeriodStart: `${dayOf(i)}T00:00:00.000Z`,
          ChargePeriodEnd: `${dayOf(i + 1)}T00:00:00.000Z`,
        }),
      );
    }
  return `${lines.join("\n")}\n`;
}

/** A quiet account: 12 GB of Fast Data Transfer and 90,000 edge requests a day, for $0.60. */
export const STEADY = chargesBody([
  { service: "Fast Data Transfer", unit: "GB", quantity: 12, cost: 0.6 },
  { service: "Edge Requests", unit: "Requests", quantity: 90_000, cost: 0 },
]);

/** The same account on 10 Nov, after the specials page started printing the time: 41 GB for $2.05. */
export const JUMPED = chargesBody([
  {
    service: "Fast Data Transfer",
    unit: "GB",
    quantity: (i) => (i === 14 ? 41 : 12),
    cost: (i) => (i === 14 ? 2.05 : 0.6),
  },
  { service: "Edge Requests", unit: "Requests", quantity: 90_000, cost: 0 },
]);

export interface PageSpec {
  status?: number;
  headers?: Record<string, string>;
  /** The body for the nth visit (0 is the first) to this address. */
  body: (visit: number) => string;
  /** Headers added for the nth visit. */
  perVisit?: (visit: number) => Record<string, string>;
}

const html = (title: string, rest: string, nonce = "static") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><script nonce="${nonce}">window.x=1</script></head><body><h1>${title}</h1>${rest}</body></html>`;

const vercel = (cache: string, cc: string) => ({
  "content-type": "text/html; charset=utf-8",
  server: "Vercel",
  "x-vercel-cache": cache,
  "cache-control": cc,
});

export const BAR_PAGES: Record<string, PageSpec> = {
  "/": {
    body: (n) => html("Marlowe Bar", "<p>Open Tuesday to Sunday.</p>", `n${n}k${n * 7919}`),
    headers: vercel("HIT", "public, max-age=0, must-revalidate"),
    perVisit: (n) => ({
      "x-vercel-cache": n === 0 ? "MISS" : "HIT",
      ...(n > 0 ? { age: "12" } : {}),
    }),
  },
  "/specials": {
    body: (n) =>
      html(
        "Tonight's specials",
        `<p>Updated 2026-11-11T09:00:${String(3 + n * 5).padStart(2, "0")}Z</p>`,
      ),
    headers: vercel("MISS", "private, no-store, max-age=0"),
  },
  "/menu": {
    body: () => html("Menu", "<p>Fish and chips, 14.</p>"),
    headers: vercel("STALE", "public, s-maxage=1, stale-while-revalidate=59"),
  },
  "/events": {
    body: () => html("Events", "<p>Quiz night, Thursday.</p>"),
    headers: vercel("MISS", "public, max-age=0, must-revalidate"),
  },
};

export interface World {
  transport: Transport;
  seen: Seen[];
  /** How many GETs each address has had. */
  visits: Map<string, number>;
}

/**
 * The bar's site and its Vercel usage. `charges` is what the billing endpoint answers (a status and a
 * body), or nothing, for an unrecorded address (a 404). `pages` overrides the site's pages.
 */
export function world(
  over: {
    host?: string;
    pages?: Record<string, PageSpec>;
    charges?: Record<string, { status: number; body?: string; headers?: Record<string, string> }>;
  } = {},
): World {
  const host = over.host ?? "marlowe-bar.example";
  const pages = over.pages ?? BAR_PAGES;
  const charges = over.charges ?? { [CHARGES_URL_TEAM]: { status: 200, body: STEADY } };
  const seen: Seen[] = [];
  const visits = new Map<string, number>();
  const answer = (status: number, headers: Record<string, string>, body: string, method: string) =>
    Promise.resolve({
      status,
      headers,
      body: Readable.from(method === "HEAD" ? [] : [Buffer.from(body)]),
    });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const hit = charges[url.href];
    if (hit)
      return answer(
        hit.status,
        { "content-type": "application/jsonl", ...hit.headers },
        hit.body ?? "",
        req.method,
      );
    if (url.hostname === host) {
      const spec = pages[url.pathname];
      if (spec) {
        const n = req.method === "GET" ? (visits.get(url.pathname) ?? 0) : 0;
        if (req.method === "GET") visits.set(url.pathname, n + 1);
        return answer(
          spec.status ?? 200,
          { ...spec.headers, ...spec.perVisit?.(n) },
          spec.body(n),
          req.method,
        );
      }
    }
    return answer(404, { "content-type": "text/plain" }, "not found", req.method);
  };
  return { transport, seen, visits };
}

/**
 * Ember Pop-up Kitchen, an invented pop-up on Wix: its home page prints how many seats are left, a
 * number that changes on every visit. A fixed plan, so its hosting has no usage to watch.
 */
export const POPUP = {
  host: "ember-popup.example",
  pages: {
    "/": {
      body: (n: number) =>
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ember Pop-up Kitchen</title><meta name="generator" content="Wix.com Website Builder"></head><body><h1>Ember Pop-up Kitchen</h1><p>Seats left tonight: ${14 - n}</p></body></html>`,
      headers: { "content-type": "text/html; charset=utf-8", "x-wix-request-id": "1699-ember" },
    },
  } satisfies Record<string, PageSpec>,
};
