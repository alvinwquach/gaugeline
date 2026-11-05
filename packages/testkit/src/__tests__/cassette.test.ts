import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot, createFetcher, createNetworkTransport, findKeys } from "@gaugeline/core";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import {
  CassetteMissError,
  readCassette,
  serialiseCassette,
  useCassette,
  writeCassetteAtomic,
  type Cassette,
} from "../cassette.js";
import { SAFE_EMAIL, SCRUBBED, scrub, scrubBody, scrubText, type Interaction } from "../scrub.js";

const temps: string[] = [];
const servers: Array<FixtureServer | Fixture> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-cassette-"));
  temps.push(d);
  return d;
}
const noCi = { CI: undefined };
const fakeStripe = "rk_test_" + "Q1w2E3r4T5y6U7i8O9p0";
const fakeSecret = "sk_live_" + "Z9x8C7v6B5n4M3a2S1d0F9g8";

function cassette(interactions: Interaction[]): Cassette {
  return { version: 1, name: "t", recordedAt: "2026-01-01T00:00:00.000Z", interactions };
}
function write(dir: string, name: string, c: Cassette) {
  writeCassetteAtomic(join(dir, `${name}.json`), { ...c, name });
}
const i = (url: string, body: string, status = 200): Interaction => ({
  method: "GET",
  url,
  status,
  headers: { "content-type": "application/json" },
  body,
});

describe("cassette replay: unit", () => {
  it("replay returns the recorded status, headers and body for a matching GET", async () => {
    const dir = tempDir();
    write(dir, "one", cassette([i("https://api.example/v1/items", '{"ok":true}', 201)]));
    const f = createFetcher({ transport: useCassette("one", { dir, env: noCi }) });
    const [hop] = await f.get("https://api.example/v1/items");
    expect([hop?.status, hop?.headers["content-type"], hop?.body]).toEqual([
      201,
      "application/json",
      '{"ok":true}',
    ]);
  });

  it("the same URL twice replays interaction one then two; a third request throws CassetteMissError", async () => {
    const dir = tempDir();
    write(
      dir,
      "two",
      cassette([i("https://api.example/page", "first"), i("https://api.example/page", "second")]),
    );
    const t = useCassette("two", { dir, env: noCi });
    const req = { method: "GET" as const, headers: {}, timeoutMs: 1000 };
    const body = async () => {
      const r = await t(new URL("https://api.example/page"), req);
      return (await r.body.toArray()).join("");
    };
    expect(await body()).toBe("first");
    expect(await body()).toBe("second");
    await expect(t(new URL("https://api.example/page"), req)).rejects.toBeInstanceOf(
      CassetteMissError,
    );
  });

  it("an unmatched URL throws and the message contains the address with its query scrubbed", async () => {
    const dir = tempDir();
    write(dir, "miss", cassette([]));
    const t = useCassette("miss", { dir, env: noCi });
    const err = await t(new URL("https://api.example/x?token=abc123"), {
      method: "GET",
      headers: {},
      timeoutMs: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CassetteMissError);
    expect((err as Error).message).toContain(`GET https://api.example/x?token=${SCRUBBED}`);
    expect((err as Error).message).not.toContain("abc123");
  });

  it("a request recorded with a real token matches when replayed with a different token", async () => {
    const dir = tempDir();
    write(dir, "tok", cassette([scrub(i("https://api.example/x?token=one", "ok"))]));
    const t = useCassette("tok", { dir, env: noCi });
    const r = await t(new URL("https://api.example/x?token=two"), {
      method: "GET",
      headers: {},
      timeoutMs: 1,
    });
    expect(r.status).toBe(200);
  });

  it("default scrubbers: a Stripe-shaped key in a body, a token query parameter, an authorization header, an email", () => {
    const out = scrub({
      method: "GET",
      url: "https://api.example/v1?token=abc&page=2",
      status: 200,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeStripe}`,
        "set-cookie": "s=1",
        link: "<...>; rel=next",
      },
      body: JSON.stringify({ key: fakeSecret, owner: "jo.bloggs@shop.example", note: "fine" }),
    });
    expect(out.url).toBe(`https://api.example/v1?token=${SCRUBBED}&page=2`);
    expect(out.headers).toEqual({ "content-type": "application/json", link: "<...>; rel=next" });
    expect(JSON.parse(out.body)).toEqual({ key: SCRUBBED, owner: SAFE_EMAIL, note: "fine" });
  });

  it("scrubbing is idempotent", () => {
    const once = scrub(
      i(`https://api.example/?api_key=x`, `{"a":"${fakeSecret}","b":"x@y.example"}`),
    );
    expect(scrub(once)).toEqual(once);
  });

  it("written JSON is byte-stable across two recordings of the same fixture apart from recordedAt", async () => {
    const site = await startFixture("clean");
    servers.push(site);
    const port = new URL(site.origin).port;
    const record = async (dir: string, at: string) => {
      const t = useCassette("stable", {
        dir,
        mode: "record",
        env: noCi,
        now: () => new Date(at),
        transport: createNetworkTransport({ hosts: { "provider.test": `127.0.0.1:${port}` } }),
      });
      const f = createFetcher({ transport: t, concurrency: 1 });
      await f.get("http://provider.test/");
      await f.get("http://provider.test/robots.txt");
      return readFileSync(join(dir, "stable.json"), "utf8");
    };
    const a = await record(tempDir(), "2026-01-01T00:00:00.000Z");
    const b = await record(tempDir(), "2026-02-02T00:00:00.000Z");
    expect(a.replace(/"recordedAt": "[^"]+"/, "")).toBe(b.replace(/"recordedAt": "[^"]+"/, ""));
    expect(a).not.toBe(b);
  });
});

describe("cassette record and replay: integration (fixture stands in for the provider)", () => {
  it("record with a fake key in the query and a header: the file contains neither; replay with the server stopped", async () => {
    const queryKey = "tok_" + "e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3";
    const s = await startServer({
      "/v1/products": (_q, res) =>
        void res
          .writeHead(200, { "content-type": "application/json", "set-cookie": "session=abc" })
          .end(
            JSON.stringify({
              data: [
                {
                  id: "price_" + "1Abc2Def3Ghi4Jkl5Mno6Pqr",
                  amount: 4800,
                  contact: "owner@shop.example",
                },
              ],
            }),
          ),
    });
    servers.push(s);
    const dir = tempDir();
    const t = useCassette("products", {
      dir,
      mode: "record",
      env: noCi,
      transport: createNetworkTransport({ hosts: { "api.provider.test": `127.0.0.1:${s.port}` } }),
    });
    const f = createFetcher({ transport: t });
    await f.get(`http://api.provider.test/v1/products?access_token=${queryKey}`, {
      headers: { authorization: `Bearer ${fakeStripe}` },
    });
    const text = readFileSync(join(dir, "products.json"), "utf8");
    for (const secret of [queryKey, fakeStripe, "session=abc", "owner@shop.example"])
      expect(text).not.toContain(secret);
    expect(text).toContain("price_1Abc2Def3Ghi4Jkl5Mno6Pqr");

    await s.close();
    servers.splice(0);
    const before = s.log.length;
    const replay = createFetcher({ transport: useCassette("products", { dir, env: noCi }) });
    const [hop] = await replay.get(`http://api.provider.test/v1/products?access_token=different`);
    expect((JSON.parse(hop?.body ?? "{}") as { data: { amount: number }[] }).data[0]?.amount).toBe(
      4800,
    );
    expect(s.log.length).toBe(before);
  });

  it("record mode with CI=true refuses with a clear message and writes nothing", () => {
    const dir = tempDir();
    expect(() => useCassette("nope", { dir, mode: "record", env: { CI: "true" } })).toThrow(
      /Refusing to record a cassette in CI/,
    );
    expect(() => useCassette("nope", { dir, env: { CI: "true", GAUGELINE_RECORD: "1" } })).toThrow(
      /in CI/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a POST attempted in record mode is stopped by assertReadOnly and nothing is written", async () => {
    const dir = tempDir();
    const t = useCassette("post", {
      dir,
      mode: "record",
      env: noCi,
      transport: () => Promise.reject(new Error("never called")),
    });
    await expect(
      t(new URL("https://api.example/"), { method: "POST" as "GET", headers: {}, timeoutMs: 1 }),
    ).rejects.toThrow(/read-only/);
    expect(existsSync(join(dir, "post.json"))).toBe(false);
  });

  it("recording with a Stripe secret key is refused", async () => {
    const dir = tempDir();
    const t = useCassette("secret", {
      dir,
      mode: "record",
      env: noCi,
      transport: () => Promise.reject(new Error("never called")),
    });
    await expect(
      t(new URL("https://api.stripe.example/v1/prices"), {
        method: "GET",
        headers: { authorization: `Bearer ${fakeSecret}` },
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/restricted read-only key \(rk_/);
    expect(existsSync(join(dir, "secret.json"))).toBe(false);
  });
});

describe("cassette replay: promise test (no network)", () => {
  it("with fetch and net connect stubbed to throw, a full replayed test still passes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network used in replay");
    });
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("socket opened in replay");
    });
    const f = createFetcher({ transport: useCassette("example-fixture", { env: noCi }) });
    const snapshot = buildSnapshot(await f.get("http://provider.test/"));
    expect(snapshot.title).toBe("Fixture Bakery");
    expect((await f.get("http://provider.test/robots.txt"))[0]?.body).toContain("User-agent");
    expect((await f.get("http://provider.test/menu", { method: "HEAD" }))[0]?.status).toBe(200);
  });
});

describe("cassettes: edge cases", () => {
  it("a key split across JSON \\u escapes is found on the parsed value", () => {
    const escaped = `{"k":"${fakeSecret.slice(0, 2)}\\u005f${fakeSecret.slice(3)}"}`;
    expect(escaped).not.toContain(fakeSecret);
    expect(JSON.parse(scrubBody(escaped))).toEqual({ k: SCRUBBED });
  });

  it("a key inside a base64 body is decoded, scrubbed and re-encoded; gzip bodies are decoded by the transport", async () => {
    const b64 = Buffer.from(`{"secret":"${fakeSecret}"}`).toString("base64");
    const cleaned = scrubText(`data=${b64}`);
    expect(Buffer.from(cleaned.slice(5), "base64").toString()).not.toContain(fakeSecret);
    const s = await startServer({
      "/gz": (_q, res) =>
        void res
          .writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" })
          .end(gzipSync(`key: ${fakeSecret}`)),
    });
    servers.push(s);
    const dir = tempDir();
    const t = useCassette("gz", {
      dir,
      mode: "record",
      env: noCi,
      transport: createNetworkTransport({ allowPrivate: true }),
    });
    await createFetcher({ transport: t }).get(`http://127.0.0.1:${s.port}/gz`);
    const stored = readCassette(join(dir, "gz.json")).interactions[0];
    expect(stored?.body).toBe(`key: ${SCRUBBED}`);
    expect(stored?.headers).toEqual({ "content-type": "text/plain" });
  });

  it("a body that is not JSON (an HTML error page) is stored as a string and scrubbed by pattern", () => {
    const out = scrubBody(
      `<html><p>Error for token ${fakeSecret} sent to help@printful.example</p></html>`,
    );
    expect(out).toBe(`<html><p>Error for token ${SCRUBBED} sent to ${SAFE_EMAIL}</p></html>`);
  });

  it("legitimate long ids are not flagged: asset hashes and object ids", () => {
    const safe = [
      "image-a3f1c9e2b7d4058c6e1f2a3b4c5d6e7f8a9b0c1d-1200x800-png",
      "price_" + "1Abc2Def3Ghi4Jkl5Mno6Pqr",
      "prod_" + "QwErTyUiOpAsDfGhJkLz",
      "d41d8cd98f00b204e9800998ecf8427e",
      "sha256-2f3a9d0e1c4b7a6f5e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f",
    ];
    for (const s of safe) expect(findKeys(s), s).toEqual([]);
    expect(findKeys(`api_key: "e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3"`)).toEqual(["generic-secret"]);
  });

  it("two users of the same cassette name each get their own queue", async () => {
    const dir = tempDir();
    write(dir, "shared", cassette([i("https://api.example/a", "only")]));
    const a = useCassette("shared", { dir, env: noCi });
    const b = useCassette("shared", { dir, env: noCi });
    const req = { method: "GET" as const, headers: {}, timeoutMs: 1 };
    expect((await a(new URL("https://api.example/a"), req)).status).toBe(200);
    expect((await b(new URL("https://api.example/a"), req)).status).toBe(200);
  });

  it("a cassette with version 2 is rejected with a message that says to re-record", () => {
    const dir = tempDir();
    writeCassetteAtomic(join(dir, "v2.json"), { ...cassette([]), version: 2 as 1 });
    expect(() => useCassette("v2", { dir, env: noCi })).toThrow(/version 2.*Re-record/);
  });

  it("the write is atomic: no temp files are left behind and the output is sorted JSON", () => {
    const dir = tempDir();
    writeCassetteAtomic(join(dir, "atomic.json"), cassette([i("https://api.example/", "x")]));
    expect(readdirSync(dir)).toEqual(["atomic.json"]);
    expect(readFileSync(join(dir, "atomic.json"), "utf8")).toBe(
      serialiseCassette(cassette([i("https://api.example/", "x")])),
    );
  });
});
