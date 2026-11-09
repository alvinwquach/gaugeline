// check-community: allow-email (an invented user:pass@ address at a reserved example domain, which the body validation refuses)
import { createServer, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { buildResult } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import type { BodyError } from "../body.js";
import { parseCheckBody } from "../body.js";
import { startApp } from "../server.js";
import { testClientDir } from "./helpers/client.js";
import { createStore, StoreFull } from "../store.js";

/** One raw HTTP/1.1 request: headers exactly as given, the body optional, the reply parsed. */
function raw(
  port: number,
  lines: string[],
  body = "",
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    // Written, not ended: a half-closed socket makes the server end a long-lived stream early.
    // "Connection: close" has the server close it once the answer is complete.
    const c = connect({ host: "127.0.0.1", port }, () =>
      c.write(
        `${lines.join("\r\n")}\r\nConnection: close\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`,
      ),
    );
    let data = "";
    c.on("data", (d) => (data += d.toString()));
    c.on("end", () => {
      const i = data.indexOf("\r\n\r\n");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0),
        head: data.slice(0, i),
        body: data.slice(i + 4),
      });
    });
    c.on("error", reject);
  });
}

/** The app, with its link opened: a client holding the session, as the browser would. */
async function client(port: number, opts: Parameters<typeof startApp>[0] = {}) {
  const app = await startApp({ clientDir: testClientDir(), port, ...opts });
  const host = `localhost:${app.port}`;
  const link = await raw(app.port, [`GET /${new URL(app.url).search} HTTP/1.1`, `Host: ${host}`]);
  const cookie = /^set-cookie: ([^;]+)/im.exec(link.head)?.[1] ?? "";
  const base = [`Host: ${host}`, `Cookie: ${cookie}`, `Origin: http://${host}`];
  const call = async (method: string, path: string, body?: unknown, extra: string[] = []) => {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const r = await raw(
      app.port,
      [
        `${method} ${path} HTTP/1.1`,
        ...base,
        ...(text ? ["Content-Type: application/json"] : []),
        ...extra,
      ],
      text,
    );
    return { ...r, json: () => JSON.parse(r.body) as Record<string, unknown> };
  };
  /** The run's events, read from the stream until it ends. */
  const events = async (id: string, extra: string[] = []) => {
    const r = await raw(app.port, [`GET /api/runs/${id}/events HTTP/1.1`, ...base, ...extra]);
    return [...r.body.matchAll(/^id: (\d+)\nevent: (\w+)\ndata: (.*)$/gm)].map((m) => ({
      id: Number(m[1]),
      event: m[2],
      data: JSON.parse(m[3] ?? "{}"),
    }));
  };
  const finished = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = (await call("GET", `/api/runs/${id}`)).json();
      if (r.state !== "running") return r;
      await new Promise((t) => setTimeout(t, 25));
    }
    throw new Error("the run did not finish");
  };
  return { app, call, events, finished, host, cookie };
}

/** A server on 127.0.0.1 with a counted, chosen answer. */
async function stub(answer: (res: ServerResponse) => void) {
  let hits = 0;
  const s = createServer((_q, res) => {
    hits++;
    answer(res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

const close = async (...apps: { close(): Promise<void> }[]) => {
  for (const a of apps) await a.close();
};

describe("app API: unit", () => {
  it("the body validation table", () => {
    const J = "application/json";
    const err = (ct: string | undefined, text: string) => {
      try {
        parseCheckBody(ct, text);
        return "ok";
      } catch (e) {
        return `${(e as BodyError).status} ${(e as BodyError).message}`;
      }
    };
    const table: [string | undefined, string, string][] = [
      [undefined, '{"url":"a.example"}', "415"],
      ["text/plain", '{"url":"a.example"}', "415"],
      [J, "{nope", "400 The request isn't valid JSON."],
      [J, '["a.example"]', "400"],
      [J, "{}", "400 The only key is url"],
      [J, '{"url":42}', "400 The address must be text"],
      [J, '{"url":"a.example","extra":1}', "400 The only key is url"],
      [
        J,
        JSON.stringify({ url: `a.example/${"x".repeat(2040)}` }),
        "400 The address is longer than 2048 characters.",
      ],
      [J, '{"url":"ftp://a.example/"}', "400"],
      [J, '{"url":"javascript:alert(1)"}', "400"],
      [
        J,
        '{"url":"https://user:pass@a.example/"}',
        "400 Leave the username and password out of the address.",
      ],
      [J, '{"url":"a.example"}', "ok"],
      [`${J}; charset=utf-8`, '{"url":"https://bücher.example/"}', "ok"],
    ];
    for (const [ct, text, want] of table)
      expect(err(ct, text), `${ct} ${text.slice(0, 40)}`).toMatch(
        new RegExp(`^${want.replace(/[.()?]/g, "\\$&")}`),
      );
    expect(parseCheckBody(J, '{"url":"https://bücher.example/"}').url).toBe(
      "https://xn--bcher-kva.example/",
    );
  });

  it("store: insertion order, the oldest finished run evicted, a running run never", () => {
    const store = createStore({ max: 3 });
    const a = store.add("https://a.example/");
    const b = store.add("https://b.example/");
    const c = store.add("https://c.example/");
    expect(store.list().map((r) => r.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);
    b.state = "done";
    c.state = "failed";
    store.add("https://d.example/");
    expect(store.list().map((r) => r.url)).toEqual([
      "https://a.example/",
      "https://c.example/",
      "https://d.example/",
    ]);
    expect(store.get(a.id)).toBe(a);
    const full = createStore({ max: 1 });
    full.add("https://x.example/");
    expect(() => full.add("https://y.example/")).toThrow(StoreFull);
  });
});

describe("app API: integration (fixture sites, real sockets)", () => {
  it("POST /api/check: 202; the events arrive in order and end with done; the run is the --json result", async () => {
    const site = await startFixture("clean");
    const now = () => new Date("2026-11-07T03:00:00Z");
    const c = await client(5300, { now });
    try {
      const started = await c.call("POST", "/api/check", { url: site.origin });
      expect(started.status).toBe(202);
      const id = String(started.json().id);
      const evs = await c.events(id);
      expect(evs.map((e) => e.id)).toEqual(evs.map((_, i) => i + 1));
      expect(evs.map((e) => e.event)).toEqual([...evs.slice(0, -1).map(() => "step"), "done"]);
      expect(evs[0]?.data).toEqual({ text: "Loading the page without JavaScript" });
      const run = await c.finished(id);
      // The CLI's --json for the same fixture, same clock: the same object.
      const out: string[] = [];
      const { main } = await import("../../../cli/src/main.js");
      await main(
        [site.origin, "--json", "--allow-private"],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => undefined },
          env: {},
          now,
        },
        { cwd: (await import("node:os")).tmpdir() },
      );
      const cli = JSON.parse(out.join("")) as ReturnType<typeof buildResult>;
      expect(run.result).toEqual(cli);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
      expect(
        site.requests.every(
          (q) =>
            q.headers.cookie === undefined && /^Gaugeline\//.test(String(q.headers["user-agent"])),
        ),
      ).toBe(true);
    } finally {
      await close(c.app, site);
    }
  });

  it("a site that redirects to the app's own address: the hop is refused, the app gets no request from its fetcher", async () => {
    const c = await client(5310);
    const site = await stub((res) =>
      res.writeHead(302, { location: `http://127.0.0.1:${c.app.port}/api/runs` }).end(),
    );
    try {
      const id = String((await c.call("POST", "/api/check", { url: site.origin })).json().id);
      const before = c.app.received();
      // Wait on the event stream: exactly one request from us, so any other would be the fetcher's.
      const evs = await c.events(id);
      expect(evs.at(-1)?.event).toBe("failed");
      expect(c.app.received() - before).toBe(1);
      // The page itself pointed there: there is no page to check, and the reason says why.
      const run = (await c.call("GET", `/api/runs/${id}`)).json();
      expect([run.state, run.reason]).toEqual([
        "failed",
        expect.stringContaining("only on the address you typed"),
      ]);
      expect(site.hits()).toBe(1);
    } finally {
      await close(c.app, site);
    }
  });

  it("a redirect to 169.254.169.254: refused (never sent), and the run ends saying so", async () => {
    const c = await client(5320);
    const site = await stub((res) =>
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end(),
    );
    try {
      const id = String((await c.call("POST", "/api/check", { url: site.origin })).json().id);
      const run = await c.finished(id);
      expect([run.state, run.reason]).toEqual([
        "failed",
        expect.stringContaining("169.254.169.254, a link-local address"),
      ]);
    } finally {
      await close(c.app, site);
    }
  });

  it("an unknown run id: 404 as JSON; POST to /api/runs: 405 with an Allow header", async () => {
    const c = await client(5330);
    try {
      const missing = await c.call("GET", "/api/runs/nope");
      expect([missing.status, missing.head]).toEqual([
        404,
        expect.stringMatching(/content-type: application\/json/i),
      ]);
      const wrong = await c.call("POST", "/api/runs", { url: "x" });
      expect(wrong.status).toBe(405);
      expect(wrong.head).toMatch(/^allow: GET\r?$/im);
    } finally {
      await c.app.close();
    }
  });

  it("two checks started together never have more than 5 requests in flight in total", async () => {
    const site = await startFixture("links");
    const c = await client(5340);
    try {
      const [a, b] = await Promise.all([
        c.call("POST", "/api/check", { url: site.origin }),
        c.call("POST", "/api/check", { url: `${site.origin}/tools` }),
      ]);
      await c.finished(String(a.json().id));
      await c.finished(String(b.json().id));
      expect(site.maxConcurrent).toBeLessThanOrEqual(5);
      expect(site.total).toBeGreaterThan(5);
    } finally {
      await close(c.app, site);
    }
  });

  it("an event stream opened after the run finished gets the full replay, then done; Last-Event-ID skips ahead", async () => {
    const site = await startFixture("clean");
    const c = await client(5350);
    try {
      const id = String((await c.call("POST", "/api/check", { url: site.origin })).json().id);
      await c.finished(id);
      const all = await c.events(id);
      expect(all.at(-1)?.event).toBe("done");
      const rest = await c.events(id, [`Last-Event-ID: ${all.length - 1}`]);
      expect(rest.map((e) => e.event)).toEqual(["done"]);
    } finally {
      await close(c.app, site);
    }
  });
});

describe("app API: edge cases", () => {
  it("the client drops the event stream mid-run: the run finishes and its listener is removed", async () => {
    const site = await stub((res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("<p>slow</p>"), 300);
    });
    const c = await client(5360);
    try {
      const id = String((await c.call("POST", "/api/check", { url: site.origin })).json().id);
      await new Promise<void>((resolve) => {
        const s = connect({ host: "127.0.0.1", port: c.app.port }, () => {
          s.write(
            `GET /api/runs/${id}/events HTTP/1.1\r\nHost: ${c.host}\r\nCookie: ${c.cookie}\r\n\r\n`,
          );
          setTimeout(() => {
            s.destroy();
            resolve();
          }, 100);
        });
      });
      await c.finished(id);
      expect(c.app.store.get(id)?.listeners.size).toBe(0);
    } finally {
      await close(c.app, site);
    }
  });

  it("a 4097-byte body sent in 1-byte chunks: 413, and the connection is closed", async () => {
    const c = await client(5370);
    try {
      const body = `{"url":"${"a".repeat(4087)}"}`;
      expect(Buffer.byteLength(body)).toBe(4097);
      const reply = await new Promise<string>((resolve) => {
        let data = "";
        const s = connect({ host: "127.0.0.1", port: c.app.port }, async () => {
          s.write(
            `POST /api/check HTTP/1.1\r\nHost: ${c.host}\r\nCookie: ${c.cookie}\r\nOrigin: http://${c.host}\r\nContent-Type: application/json\r\nContent-Length: 4097\r\n\r\n`,
          );
          for (const ch of body) {
            if (s.destroyed) break;
            s.write(ch);
            if (data) break;
            await new Promise((t) => setImmediate(t));
          }
        });
        s.on("data", (d) => (data += d.toString()));
        s.on("close", () => resolve(data));
        s.on("error", () => resolve(data));
      });
      expect(reply).toMatch(/^HTTP\/1\.1 413/);
      expect(reply).toMatch(/connection: close/i);
    } finally {
      await c.app.close();
    }
  });

  it("the explicit target is the app's own address: allowed, the run finishes, and it reports the 403", async () => {
    const c = await client(5380);
    try {
      const id = String(
        (await c.call("POST", "/api/check", { url: `http://localhost:${c.app.port}/` })).json().id,
      );
      const run = await c.finished(id);
      expect(run.state).toBe("done");
      expect(JSON.stringify(run.result)).toContain("403");
    } finally {
      await c.app.close();
    }
  });
});
