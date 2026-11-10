import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { freezeEnv, isConfigured, missingVars } from "../env.js";
import { ConnectorRefusedError, connectorGet } from "../http.js";
import { createRedactor } from "../redact.js";
import { runConnectors } from "../run.js";
import type { Connector } from "../types.js";
import { fake, testKey } from "./fake.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
async function serve(...args: Parameters<typeof startServer>): Promise<FixtureServer> {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}

describe("configured: unit", () => {
  it("is true only when every name is a non-empty string", () => {
    expect(isConfigured({ A: "a", B: "b" }, ["A", "B"])).toBe(true);
    expect(isConfigured({ A: "a" }, ["A", "B"])).toBe(false);
    expect(isConfigured({ A: "a", B: undefined }, ["A", "B"])).toBe(false);
    expect(isConfigured({ A: "a", B: "" }, ["A", "B"])).toBe(false);
    expect(missingVars({ A: "a", B: "" }, ["A", "B", "C"])).toEqual(["B", "C"]);
  });

  it("a variable set to an empty string counts as not configured", async () => {
    const c = fake("stripe", ["STRIPE_API_KEY"], async () => [1]);
    expect(c.configured({ STRIPE_API_KEY: "" })).toBe(false);
    const run = await runConnectors([c], { STRIPE_API_KEY: "" }, createFetcher());
    expect(run.data.size).toBe(0);
    expect(run.notices).toEqual([
      expect.objectContaining({ connector: "stripe", kind: "not-configured" }),
    ]);
    expect(run.notices[0]?.message).toContain("STRIPE_API_KEY");
  });

  it("freezeEnv copies only the named variables and cannot be changed afterwards", () => {
    const source: Record<string, string | undefined> = { A: "a", B: "", C: "secret", D: undefined };
    const env = freezeEnv(source, ["A", "B", "D"]);
    expect(env).toEqual({ A: "a", B: "" });
    expect(Object.isFrozen(env)).toBe(true);
    source.A = "changed";
    expect(env.A).toBe("a");
    expect(() => {
      (env as Record<string, string>).A = "x";
    }).toThrow(TypeError);
  });
});

describe("runConnectors: unit", () => {
  it("three fakes, one throws: data has two entries and notices has one unreachable", async () => {
    const env = { ONE: "1", TWO: "2", THREE: "3" };
    const run = await runConnectors(
      [
        fake("sanity", ["ONE"], async () => [{ n: 1 }]),
        fake("stripe", ["TWO"], async () => {
          throw new Error("socket hang up");
        }),
        fake("printful", ["THREE"], async () => [{ n: 3 }, { n: 4 }]),
      ],
      env,
      createFetcher(),
    );
    expect([...run.data.keys()]).toEqual(["sanity", "printful"]);
    expect(run.data.get("printful")).toEqual([{ n: 3 }, { n: 4 }]);
    expect(run.notices).toEqual([
      {
        connector: "stripe",
        kind: "unreachable",
        message: "stripe could not be read. socket hang up",
      },
    ]);
  });

  it("a connector that throws without being async, or throws a string, is still one notice", async () => {
    const sync: Connector<number> = {
      id: "sync",
      envVars: [],
      configured: () => true,
      read: () => {
        throw new Error("sync boom");
      },
    };
    const odd = fake("odd", [], () => Promise.reject("just a string"));
    const run = await runConnectors([sync, odd], {}, createFetcher());
    expect(run.notices.map((n) => [n.connector, n.kind])).toEqual([
      ["sync", "unreachable"],
      ["odd", "unreachable"],
    ]);
    expect(run.notices[1]?.message).toContain("just a string");
  });

  it("an answer that is not a list becomes a notice, and two connectors cannot share an id", async () => {
    const notList = fake("a", [], async () => ({ nope: true }) as unknown as unknown[]);
    const run = await runConnectors([notList], {}, createFetcher());
    expect(run.data.size).toBe(0);
    expect(run.notices[0]).toMatchObject({ connector: "a", kind: "unreachable" });
    await expect(
      runConnectors(
        [fake("a", [], async () => []), fake("a", [], async () => [])],
        {},
        createFetcher(),
      ),
    ).rejects.toThrow(/Two connectors are called "a"/);
  });

  it("gives the same notices in the same order every time", async () => {
    const set = [
      fake("b", ["B"], async () => []),
      fake("a", ["A"], async () => {
        throw new Error("down");
      }),
    ];
    const first = await runConnectors(set, { A: "x" }, createFetcher());
    const second = await runConnectors(set, { A: "x" }, createFetcher());
    expect(second).toEqual(first);
    expect(first.notices.map((n) => n.connector)).toEqual(["b", "a"]);
  });
});

describe("redactor: unit", () => {
  const key = testKey("alpha");

  it("replaces the key inside a URL, a JSON error body and a stack trace", () => {
    const redact = createRedactor({ K: key }, ["K"]);
    const url = `https://api.example.test/v1/products?limit=5&auth=${key}`;
    const body = JSON.stringify({ error: { message: `Invalid API key provided: ${key}` } });
    const stack = new Error(`request failed with ${key}`).stack ?? "";
    for (const text of [url, body, stack]) {
      expect(text).toContain(key);
      const out = redact(text);
      expect(out).not.toContain(key);
      expect(out).toContain("[redacted]");
    }
  });

  it("also catches the key percent-encoded, JSON-escaped, or with a trailing newline", () => {
    const odd = 'ab+c/d=e"f\\g';
    const redact = createRedactor({ K: `${odd}\n` }, ["K"]);
    expect(redact(`?token=${encodeURIComponent(odd)}`)).toBe("?token=[redacted]");
    expect(redact(JSON.stringify({ m: odd }))).toBe('{"m":"[redacted]"}');
    expect(redact(`key ${odd} end`)).toBe("key [redacted] end");
  });

  it("a key that is a substring of another configured key: both are redacted, longest first", () => {
    const short = "abc123456789";
    const long = `${short}XYZsuffix`;
    const redact = createRedactor({ SHORT: short, LONG: long }, ["SHORT", "LONG"]);
    expect(redact(`one ${long} two ${short} three`)).toBe("one [redacted] two [redacted] three");
    // Two keys that overlap in the text leave no leftover characters of either.
    const redactOverlap = createRedactor({ A: "abcdef", B: "defghi" }, ["A", "B"]);
    expect(redactOverlap("x abcdefghi y")).toBe("x [redacted] y");
  });

  it("does not rescan its own replacement, and ignores unset, empty and whitespace values", () => {
    expect(createRedactor({ K: "red" }, ["K"])("a red b")).toBe("a [redacted] b");
    const nothing = createRedactor({ A: "", B: "   ", C: undefined }, ["A", "B", "C", "D"]);
    expect(nothing("a b  c")).toBe("a b  c");
  });
});

describe("connectorGet: integration", () => {
  it("sends the key in an Authorization header, GET only, never in the address", async () => {
    const key = testKey("beta");
    const s = await serve({
      "/v1/items": (req, res) => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify([{ ok: req.headers.authorization === `Bearer ${key}` }]));
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hop = await connectorGet(fetcher, `${s.origin}/v1/items`, {
      authorization: `Bearer ${key}`,
    });
    expect(JSON.parse(hop.body ?? "")).toEqual([{ ok: true }]);
    expect(s.log.map((r) => r.method)).toEqual(["GET"]);
    expect(s.log[0]?.path).not.toContain(key);
    expect(
      fetcher
        .history?.()
        .map((r) => r.url)
        .join("\n"),
    ).not.toContain(key);
  });

  it("a caller's own authorization header is replaced, not doubled", async () => {
    const s = await serve({ "/x": (_req, res) => void res.writeHead(200).end("[]") });
    await connectorGet(createFetcher({ allowPrivate: true }), `${s.origin}/x`, {
      authorization: "Bearer real",
      headers: { Authorization: "Bearer sneaky", accept: "application/json" },
    });
    expect(s.log[0]?.headers.authorization).toBe("Bearer real");
    expect(s.log[0]?.headers.accept).toBe("application/json");
  });

  it("a redirect to another origin is followed without the key", async () => {
    const key = testKey("gamma");
    const other = await serve({
      "/landing": (_req, res) => void res.writeHead(200).end("[]"),
    });
    const first = await serve({
      "/start": (_req, res) =>
        void res.writeHead(302, { location: `${other.origin}/landing` }).end(),
    });
    await connectorGet(createFetcher({ allowPrivate: true }), `${first.origin}/start`, {
      authorization: `Bearer ${key}`,
    });
    expect(first.log[0]?.headers.authorization).toBe(`Bearer ${key}`);
    expect(other.log[0]?.path).toBe("/landing");
    expect(other.log[0]?.headers.authorization).toBeUndefined();
  });
});

describe("runConnectors: integration", () => {
  it("a system that answers 401: the notice says it refused the key, and the key is not in it", async () => {
    const key = testKey("delta");
    const s = await serve({
      "/v1/products": (req, res) => {
        // A server that echoes the key back in its error body, as some do.
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: `Invalid API Key provided: ${req.headers.authorization}` }));
      },
    });
    const lines: string[] = [];
    const run = await runConnectors(
      [
        fake("stripe", ["STRIPE_API_KEY"], async (env, fetcher) => {
          const hop = await connectorGet(fetcher, `${s.origin}/v1/products`, {
            authorization: `Bearer ${env.STRIPE_API_KEY}`,
          });
          return [hop.body];
        }),
      ],
      { STRIPE_API_KEY: key },
      createFetcher({ allowPrivate: true }),
      { debug: (l) => lines.push(l) },
    );
    expect(run.data.size).toBe(0);
    expect(run.notices).toHaveLength(1);
    const n = run.notices[0];
    expect(n?.kind).toBe("refused");
    expect(n?.message).toContain("stripe refused the key");
    expect(n?.message).toContain("401");
    expect(JSON.stringify(run)).not.toContain(key);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.length).toBeGreaterThan(0);
    expect(s.log.map((r) => r.method)).toEqual(["GET"]);
  });

  it("a 500 is unreachable, with the status and nothing from the body", async () => {
    const s = await serve({
      "/v1": (_req, res) => void res.writeHead(500).end("stack trace with secret details"),
    });
    const run = await runConnectors(
      [
        fake("printful", [], async (_e, f) => [
          await connectorGet(f, `${s.origin}/v1`, { authorization: "Bearer x" }),
        ]),
      ],
      {},
      createFetcher({ allowPrivate: true }),
    );
    expect(run.notices).toEqual([
      {
        connector: "printful",
        kind: "unreachable",
        message: "printful could not be read. The system answered HTTP 500.",
      },
    ]);
  });

  it("no variables set at all: zero requests, three not-configured notices, the site check still runs", async () => {
    const site = await serve({
      "/": (_req, res) =>
        void res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<!doctype html><html lang="en"><head><title>Pop-up kitchen</title></head><body><h1>Supper club</h1></body></html>',
          ),
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const reads: string[] = [];
    const three = [
      ["sanity", "SANITY_TOKEN"],
      ["stripe", "STRIPE_API_KEY"],
      ["printful", "PRINTFUL_API_TOKEN"],
    ].map(([id, name]) =>
      fake(id as string, [name as string], async (_e, f) => {
        reads.push(id as string);
        return [await f.get(`${site.origin}/never`)];
      }),
    );
    const run = await runConnectors(three, {}, fetcher);
    expect(fetcher.stats.requests).toBe(0);
    expect(reads).toEqual([]);
    expect(run.data.size).toBe(0);
    expect(run.notices.map((n) => [n.connector, n.kind])).toEqual([
      ["sanity", "not-configured"],
      ["stripe", "not-configured"],
      ["printful", "not-configured"],
    ]);
    const check = await checkSite({ address: site.origin, fetcher });
    expect(check.snapshot.title).toBe("Pop-up kitchen");
    expect(fetcher.stats.requests).toBeGreaterThan(0);
  });
});

describe("runConnectors: edge cases", () => {
  it("a connector that never answers: the fetcher timeout makes it unreachable and the others are not held up", async () => {
    const s = await serve({
      "/hang": () => new Promise<void>(() => undefined),
    });
    const finished: string[] = [];
    const run = await runConnectors(
      [
        fake("stripe", ["K"], async (_e, f) => {
          try {
            return [await connectorGet(f, `${s.origin}/hang`, { authorization: "Bearer k" })];
          } finally {
            finished.push("stripe");
          }
        }),
        fake("sanity", ["K"], async () => {
          finished.push("sanity");
          return [{ id: "mug" }];
        }),
      ],
      { K: "k-value-1234" },
      createFetcher({ allowPrivate: true, timeoutMs: 300 }),
    );
    expect(finished).toEqual(["sanity", "stripe"]);
    expect([...run.data.keys()]).toEqual(["sanity"]);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatchObject({ connector: "stripe", kind: "unreachable" });
    expect(run.notices[0]?.message).toContain("did not answer");
  });

  it("a connector that tries a POST: the fetcher refuses it before anything is sent", async () => {
    const s = await serve({ "/v1": (_req, res) => void res.writeHead(200).end("[]") });
    const fetcher = createFetcher({ allowPrivate: true });
    const post = { method: "POST" } as unknown as { method: "GET" };
    expect(() => fetcher.get(`${s.origin}/v1`, post)).toThrow(
      "Gaugeline is read-only: refusing to send a POST request.",
    );
    const run = await runConnectors(
      [fake("stripe", [], async (_e, f) => [await f.get(`${s.origin}/v1`, post)])],
      {},
      fetcher,
    );
    expect(s.log).toEqual([]);
    expect(fetcher.stats.requests).toBe(0);
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toContain("read-only");
  });

  it("a very long error message is cut after redaction, so a cut never exposes half a key", async () => {
    const key = testKey("epsilon");
    const run = await runConnectors(
      [
        fake("stripe", ["K"], async () => {
          throw new Error(`${"x".repeat(270)}${key}${"y".repeat(500)}`);
        }),
      ],
      { K: key },
      createFetcher(),
    );
    const message = run.notices[0]?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message).not.toContain(key.slice(0, 12));
  });
});

describe("keys never reach the output: promise test", () => {
  it("a run with fixture keys in env: the result, the notices, the debug lines and a failure's stack hold none of them", async () => {
    const keys = {
      SANITY_TOKEN: testKey("s"),
      STRIPE_API_KEY: testKey("t"),
      PRINTFUL_API_TOKEN: testKey("p"),
    };
    const s = await serve({
      "/a": (req, res) =>
        void res.writeHead(401).end(`bad key ${req.headers.authorization} ${keys.SANITY_TOKEN}`),
    });
    const lines: string[] = [];
    const leaky = (id: string, name: keyof typeof keys): Connector<unknown> =>
      fake(id, [name], async (env, f) => {
        if (id === "sanity")
          await connectorGet(f, `${s.origin}/a?token=${env[name]}`, {
            authorization: `Bearer ${env[name]}`,
          });
        if (id === "stripe")
          throw new Error(
            `failed at https://x.test/?key=${env[name]}\n${new Error(String(env[name])).stack}`,
          );
        return [{ id: "mug", note: "ok" }];
      });
    const run = await runConnectors(
      [
        leaky("sanity", "SANITY_TOKEN"),
        leaky("stripe", "STRIPE_API_KEY"),
        leaky("printful", "PRINTFUL_API_TOKEN"),
      ],
      keys,
      createFetcher({ allowPrivate: true }),
      { debug: (l) => lines.push(l) },
    );
    const everything =
      JSON.stringify({ data: [...run.data], notices: run.notices }) + lines.join("\n");
    for (const key of Object.values(keys)) expect(everything).not.toContain(key);
    expect(run.notices).toHaveLength(2);
    expect(run.data.get("printful")).toEqual([{ id: "mug", note: "ok" }]);
  });
});

describe("core stays out of process state", () => {
  it("no file in packages/core/src/connectors reads process, and the only network call is fetcher.get", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(4);
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/\bprocess\b/);
      expect(text, f).not.toMatch(
        /\bfetch\(|node:https?|node:net|XMLHttpRequest|method:\s*["']POST/i,
      );
    }
  });

  it("ConnectorRefusedError names the status and no body", () => {
    const e = new ConnectorRefusedError(403);
    expect(e.status).toBe(403);
    expect(e.message).toBe("The system refused the key (HTTP 403).");
  });
});

describe("advice, secret variables and refusal hints (added with the Sanity connector)", () => {
  const key = testKey("advice");

  it("advice becomes an advice notice after the read's own, redacted, and a failing advise gives none", async () => {
    const withAdvice: Connector<number> = {
      ...fake("a", ["A_KEY"], async () => [1]),
      advise: async () => [`use a narrower key than ${key}`],
    };
    const throwing: Connector<number> = {
      ...fake("b", ["B_KEY"], async () => [2]),
      advise: async () => {
        throw new Error(`boom ${key}`);
      },
    };
    const run = await runConnectors(
      [withAdvice, throwing],
      { A_KEY: key, B_KEY: "other" },
      createFetcher({ allowPrivate: true }),
    );
    expect([...run.data.keys()]).toEqual(["a", "b"]);
    expect(run.notices).toEqual([
      { connector: "a", kind: "advice", message: "use a narrower key than [redacted]" },
    ]);
  });

  it("advice is not asked of a connector that is not configured", async () => {
    let asked = false;
    const c: Connector<number> = {
      ...fake("a", ["A_KEY"], async () => [1]),
      advise: async () => {
        asked = true;
        return ["x"];
      },
    };
    const run = await runConnectors([c], {}, createFetcher({ allowPrivate: true }));
    expect(asked).toBe(false);
    expect(run.notices.map((n) => n.kind)).toEqual(["not-configured"]);
  });

  it("only the variables a connector lists as secret are redacted from its messages", async () => {
    const c: Connector<number> = {
      ...fake("a", ["A_PROJECT"], async () => {
        throw new Error(`dataset production, key ${key}`);
      }),
      optionalEnvVars: ["A_DATASET", "A_KEY"],
      secretEnvVars: ["A_KEY"],
    };
    const run = await runConnectors(
      [c],
      { A_PROJECT: "ember", A_DATASET: "production", A_KEY: key },
      createFetcher({ allowPrivate: true }),
    );
    expect(run.notices[0]?.message).toBe("a could not be read. dataset production, key [redacted]");
  });

  it("a refusal's hint replaces the generic advice in the notice", async () => {
    const c = fake("a", ["A_KEY"], async () => {
      throw new ConnectorRefusedError(401, "Use a Viewer token.");
    });
    const run = await runConnectors([c], { A_KEY: key }, createFetcher({ allowPrivate: true }));
    expect(run.notices[0]?.message).toBe("a refused the key (HTTP 401). Use a Viewer token.");
    expect(new ConnectorRefusedError(401, "Use a Viewer token.").message).toBe(
      "The system refused the key (HTTP 401). Use a Viewer token.",
    );
  });
});
