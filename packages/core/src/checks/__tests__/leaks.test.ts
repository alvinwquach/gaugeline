import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { PLANTED, SITES_DIR, startFixture, withPlanted } from "../../../../fixtures/src/index.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher, createNetworkTransport, type Transport } from "../../fetcher.js";
import { createBudget, LIMITS } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { SANITY_QUERY, readDataset, sanityQueryUrl, sanityRefs } from "../../sanity.js";
import { readScripts } from "../../scripts.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { datasetPrivateTypes } from "../dataset-private-types.js";
import { datasetPublic } from "../dataset-public.js";
import { DETECTORS, ENTROPY_MIN, entropy, findLeaks, redact } from "../leaks/detectors.js";
import { isPrivateType } from "../leaks/private-types.js";
import { secretInJs } from "../secret-in-js.js";

// Key-shaped values are put together at run time, so no key-shaped string is in the repository.
const stripe = (kind: "sk" | "rk" | "pk", mode: "live" | "test", rest: string) =>
  [kind, mode, rest].join("_");
const sanityToken = (rest: string) => `s${"k"}${rest}`;
const MIXED = "Zq8Lr2Vx9Nc4Tb7Hm1Kp5Wd3Fg6Js0Ya";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function page(url: string, body: string): PageSnapshot {
  return buildSnapshot([
    { url, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 },
  ]);
}

const ids = (text: string) => findLeaks(text).map((l) => l.detector);

describe("leaks: unit (detectors)", () => {
  it("there is one detector per kind of key, each with tests below", () => {
    expect(DETECTORS.map((d) => d.id)).toEqual([
      "stripe-secret",
      "sanity-token",
      "contentful-preview-token",
      "secret-assignment",
    ]);
  });

  it("stripe-secret: secret and restricted live keys; never publishable, test or short ones", () => {
    for (const hit of [
      `const k = "${stripe("sk", "live", "a1B2c3D4e5F6g7H8i9J0k1L2")}";`,
      `fetch(u, { headers: { Authorization: "Bearer ${stripe("rk", "live", "Q9w8E7r6T5y4U3i2O1p0Z9x8")}" } })`,
      `x=${stripe("sk", "live", `51Hx${MIXED}${MIXED}`)}`,
    ])
      expect(ids(hit), hit).toEqual(["stripe-secret"]);
    for (const miss of [
      `Stripe("${stripe("pk", "live", "a1B2c3D4e5F6g7H8i9J0k1L2")}")`,
      `const k = "${stripe("sk", "test", "a1B2c3D4e5F6g7H8i9J0k1L2")}";`,
      `const k = "${stripe("sk", "live", "short123")}";`,
    ])
      expect(ids(miss), miss).toEqual([]);
  });

  it("sanity-token: sk and a long mixed token; not short, one-letter or glued to a word", () => {
    for (const hit of [
      `token: "${sanityToken(`${MIXED}${MIXED}`)}"`,
      `client.config({t:"${sanityToken(`A1${MIXED}b2${MIXED}`)}"})`,
      `"${sanityToken(`${MIXED}9x${MIXED}`)}"`,
    ])
      expect(ids(hit), hit).toEqual(["sanity-token"]);
    for (const miss of [
      `"${sanityToken(MIXED.slice(0, 30) + MIXED.slice(0, 29))}"`,
      `"${sanityToken("a".repeat(70))}"`,
      `"ask${MIXED}${MIXED}"`,
    ])
      expect(ids(miss), miss).toEqual([]);
  });

  it("contentful-preview-token: a 43-character token tied to the Preview API; never a delivery token or the SDK's own host", () => {
    // Built at run time, like every key here. Both are 43 characters of base64url, as Contentful's are.
    const tail = `${MIXED}Ec9Rt5Gb7XZ`.slice(0, 37);
    const preview = `Qw4Xz8${tail}`;
    const delivery = `Hk2Pm9${tail}`;
    expect([preview.length, delivery.length]).toEqual([43, 43]);
    for (const hit of [
      `createClient({space:"abc123def456",accessToken:"${preview}",host:"preview.contentful.com"})`,
      `const c = { host: 'preview.contentful.com', environment: 'master', accessToken: '${preview}' };`,
      `fetch("https://preview.contentful.com/spaces/abc123def456/environments/master/entries?access_token=${preview}")`,
      `const contentfulPreviewToken = "${preview}";`,
    ])
      expect(ids(hit), hit).toEqual(["contentful-preview-token"]);
    // The label and the redaction: the kind is named, and only the first 6 and last 2 characters show.
    const [leak] = findLeaks(`{accessToken:"${preview}",host:"preview.contentful.com"}`);
    expect(leak?.label).toBe("Contentful preview token");
    expect(leak?.redacted).toBe(`${preview.slice(0, 6)}\u2026${preview.slice(-2)}`);
    expect(JSON.stringify(leak)).not.toContain(preview);
    // A delivery client next to a preview client: only the preview token is reported.
    const both = `createClient({accessToken:"${delivery}",host:"cdn.contentful.com"});createClient({accessToken:"${preview}",host:"preview.contentful.com"})`;
    const found = findLeaks(both).filter((l) => l.detector === "contentful-preview-token");
    expect(found.map((l) => l.redacted)).toEqual([
      `${preview.slice(0, 6)}\u2026${preview.slice(-2)}`,
    ]);
    for (const miss of [
      // The SDK's own host, with no token in the same object.
      `var h="preview.contentful.com";function f(){return {host:h}}`,
      // A delivery token for the published content, which is meant to be public.
      `createClient({space:"abc123def456",accessToken:"${delivery}",host:"cdn.contentful.com"})`,
      // A short value, a low-entropy value and a name without token or key.
      `{accessToken:"${preview.slice(0, 30)}",host:"preview.contentful.com"}`,
      `{accessToken:"${"a".repeat(43)}",host:"preview.contentful.com"}`,
      `{space:"${preview}",host:"preview.contentful.com"}`,
    ])
      expect(ids(miss), miss).not.toContain("contentful-preview-token");
  });

  it("secret-assignment: random values named SECRET, TOKEN or KEY; not public names, hashes, files or images", () => {
    for (const hit of [
      `const API_SECRET = "${MIXED}x7";`,
      `{ accessToken: '${MIXED.split("").reverse().join("")}' }`,
      `window.mailKey="${MIXED.slice(4)}Rt5Gb";`,
    ])
      expect(ids(hit), hit).toEqual(["secret-assignment"]);
    for (const miss of [
      `const PUBLIC_KEY = "${MIXED}";`,
      `const buildToken = "3f2a9c8b7d6e5f4a3b2c1d0e9f8a7b6c";`,
      `const TOKEN_COOKIE = "session-token-name-for-the-cookie";`,
    ])
      expect(ids(miss), miss).toEqual([]);
  });

  it("the entropy detector ignores hashes in file names and base64 images", () => {
    expect(entropy("3f2a9c8b7d6e5f4a3b2c1d0e9f8a7b6c")).toBeLessThan(ENTROPY_MIN);
    expect(entropy(MIXED)).toBeGreaterThan(ENTROPY_MIN);
    expect(ids(`chunkKey: "app.${MIXED}.chunk.js"`)).toEqual([]);
    expect(ids(`iconKey: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8"`)).toEqual([]);
    expect(ids(`logoKey: "/9j/4AAQSkZJRgABAQAAAQABAAD${MIXED}"`)).toEqual([]);
  });

  it("redact() keeps the first 6 and last 2 characters, never more than 8 of the original", () => {
    const key = stripe("sk", "live", "a1B2c3D4e5F6g7H8i9J0k1L2");
    expect(redact(key)).toBe("sk_liv…L2");
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (s) =>
          // At most 6 + 2 characters of the original, and nothing else of it.
          redact(s) === (s.length < 12 ? `${s.slice(0, 2)}…` : `${s.slice(0, 6)}…${s.slice(-2)}`),
      ),
    );
  });

  it("private-looking types go by the type name's last word", () => {
    for (const t of ["order", "orders", "contactSubmission", "inquiries", "customer-lead"])
      expect(isPrivateType(t), t).toBe(true);
    for (const t of ["post", "paymentSettings", "orderOfService", "sanity.imageAsset", "author"])
      expect(isPrivateType(t), t).toBe(false);
  });

  it("Sanity projects and datasets are read from cdn.sanity.io image addresses, once each", () => {
    const p = page(
      "https://pop.example/",
      [
        '<img src="https://cdn.sanity.io/images/ab12cd34/production/f00-800x600.jpg?w=400">',
        '<img src="/x.png" srcset="https://cdn.sanity.io/images/ab12cd34/production/f00-1600x1200.jpg 2x">',
        '<meta property="og:image" content="https://cdn.sanity.io/images/ab12cd34/blog/og.png">',
        '<img src="https://images.example/ab12cd34/production/x.jpg">',
      ].join(""),
    );
    expect(sanityRefs(p)).toEqual([
      { projectId: "ab12cd34", dataset: "production" },
      { projectId: "ab12cd34", dataset: "blog" },
    ]);
  });
});

describe("leaks: property", () => {
  it("for any generated secret, JSON.stringify(findings) does not contain it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9]{24,60}$/),
        fc.constantFrom<"sk" | "rk">("sk", "rk"),
        fc.string({ maxLength: 40 }).map((s) => s.replace(/[<>"\\]/g, " ")),
        async (rest, kind, before) => {
          const key = stripe(kind, "live", rest);
          const p = page(
            "https://pop.example/",
            `<script>var a = "${before}"; const STRIPE_SECRET_KEY = "${key}";</script>`,
          );
          const findings = await secretInJs.run(p, { warn: () => undefined });
          return findings.length >= 1 && !JSON.stringify(findings).includes(key);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** Fixture pages go to the local network; Sanity answers from the recorded cassette. */
function withRecordedSanity(
  log: { url: URL; method: string; headers: Record<string, string> }[] = [],
): Transport {
  const local = createNetworkTransport({ allowPrivate: true });
  const recorded = useCassette("sanity-datasets", { mode: "replay" });
  return (url, req) => {
    if (!url.hostname.endsWith(".api.sanity.io")) return local(url, req);
    log.push({ url, method: req.method, headers: req.headers });
    return recorded(url, req);
  };
}

describe("leaks: integration (the leaks fixture)", () => {
  it("a bundle with a planted key: one finding, redacted, with the file and byte offset", async () => {
    const site = await startFixture("leaks");
    try {
      const fetcher = createFetcher({ transport: withRecordedSanity(), timeoutMs: 5000 });
      const { result } = await checkSite({ address: site.origin, fetcher, only: ["secret-in-js"] });
      const key = PLANTED["stripe-secret"] ?? "";
      const served = withPlanted(readFileSync(`${SITES_DIR}leaks/assets/app.js`, "utf8"));
      const offset = Buffer.byteLength(served.slice(0, served.indexOf(key)));
      expect(result.findings.map((f) => f.evidence)).toEqual([
        `Stripe secret key ${redact(key)} in /assets/app.js at byte ${offset}`,
      ]);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("40 script tags: only 15 fetched", async () => {
    const js = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/javascript" }).end("console.log(1);");
    };
    const server = await startServer({}, js);
    servers.push(server);
    const tags = Array.from({ length: 40 }, (_, i) => `<script src="/js/${i}.js"></script>`);
    const p = page(`${server.origin}/`, `<html><head>${tags.join("")}</head></html>`);
    const budget = createBudget();
    const read = await readScripts({
      page: p,
      fetcher: createFetcher({ allowPrivate: true }),
      budget,
    });
    expect(read).toHaveLength(LIMITS.scripts);
    expect(server.log).toHaveLength(15);
    expect(budget.summary().scripts).toEqual({ limit: 15, sampled: 15, found: 40 });
  });

  it("a Sanity dataset with types [post, order]: dataset-private-types only", async () => {
    const site = await startFixture("leaks");
    try {
      const fetcher = createFetcher({ transport: withRecordedSanity(), timeoutMs: 5000 });
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["dataset-public", "dataset-private-types"],
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "dataset-private-types",
          "high",
          'project ab12cd34, dataset "production" answers without a token and has "order" among its 2 types (42 documents)',
        ],
      ]);
      expect(budget.summary().sanityDatasets).toEqual({ limit: 2, sampled: 1, found: 1 });
    } finally {
      await site.close();
    }
  });
});

describe("leaks: promise (counts and type names only)", () => {
  it("the Sanity request is a GET, with no token, whose query asks for count and _type and nothing else", async () => {
    const log: { url: URL; method: string; headers: Record<string, string> }[] = [];
    const fetcher = createFetcher({ transport: withRecordedSanity(log) });
    await readDataset(fetcher, { projectId: "ab12cd34", dataset: "production" });
    expect(log).toHaveLength(1);
    const [req] = log;
    expect(req?.method).toBe("GET");
    expect(req?.url.href).toBe(sanityQueryUrl({ projectId: "ab12cd34", dataset: "production" }));
    expect(Object.keys(req?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
    const query = req?.url.searchParams.get("query") ?? "";
    expect(query).toBe(SANITY_QUERY);
    // One object with exactly two keys: a count, and the distinct _type values. No document fields.
    expect(query).toMatch(/^\{"count": count\(\*\), "types": array::unique\(\*\[\]\._type\)\}$/);
  });
});

describe("leaks: edge cases", () => {
  it("a 9 MB bundle is scanned up to the 5 MB cap", async () => {
    const early = stripe("sk", "live", "E4rLy0K3y1nTh3F1rstMb000");
    const late = stripe("sk", "live", "L4t30K3y1nTh3S3v3nthMb00");
    const filler = "/*" + "x".repeat(1024 * 1024 - 4) + "*/";
    const bundle = `${filler}var a="${early}";${filler.repeat(6)}var b="${late}";${filler.repeat(2)}`;
    const server = await startServer({
      "/app.js": (_req, res) => {
        res.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
      },
    });
    servers.push(server);
    const p = page(`${server.origin}/`, '<script src="/app.js"></script>');
    const [read] = await readScripts({
      page: p,
      fetcher: createFetcher({ allowPrivate: true }),
      budget: createBudget(),
    });
    expect(Buffer.byteLength(bundle)).toBeGreaterThan(9 * 1024 * 1024 - 1);
    expect(read?.truncated).toBe(true);
    expect(findLeaks(read?.text ?? "").map((l) => l.redacted)).toEqual([redact(early)]);
  });

  it("a key split across a string concatenation is not found (a known miss, documented)", () => {
    expect(findLeaks(`const k = "sk_" + "live_" + "a1B2c3D4e5F6g7H8i9J0k1L2";`)).toEqual([]);
  });

  it("a private dataset: the count request is refused, which is a pass, not an error", async () => {
    const fetcher = createFetcher({ transport: withRecordedSanity() });
    const read = await readDataset(fetcher, { projectId: "pr1v4te0", dataset: "production" });
    expect([read.state, read.status]).toEqual(["private", 401]);
    const ctx: CheckContext = { warn: () => undefined, datasets: async () => [read] };
    const p = page("https://pop.example/", "");
    expect(await datasetPublic.run(p, ctx)).toEqual([]);
    expect(await datasetPrivateTypes.run(p, ctx)).toEqual([]);
  });

  it("a public dataset with no private-looking types is dataset-public, low", async () => {
    const fetcher = createFetcher({ transport: withRecordedSanity() });
    const read = await readDataset(fetcher, { projectId: "ab12cd34", dataset: "blog" });
    const ctx: CheckContext = { warn: () => undefined, datasets: async () => [read] };
    const p = page("https://pop.example/", "");
    expect((await datasetPublic.run(p, ctx)).map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        'project ab12cd34, dataset "blog": 18 documents in 3 types (author, post, siteSettings) answer without a token',
      ],
    ]);
    expect(await datasetPrivateTypes.run(p, ctx)).toEqual([]);
  });
});
