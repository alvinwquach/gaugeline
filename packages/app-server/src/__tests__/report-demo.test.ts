import { createServer, type ServerResponse } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createPageRegistry, parseResult, RESULT_SCHEMA_VERSION } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../../cli/src/version.js";
import {
  DEMO_FILE_VERSION,
  DEMO_PATH,
  DEMO_SENTENCE,
  DemoError,
  fillDemo,
  parseDemo,
} from "../demo.js";
import {
  budgetOf,
  REPORT_FILENAME,
  REPORT_POLICY,
  reportHeaders,
  renderRunReport,
} from "../report.js";
import { startApp } from "../server.js";
import { createStore } from "../store.js";
import { SAMPLE_FILES, scratchClientDir } from "./helpers/client.js";
import { client, header, raw } from "./helpers/http.js";

const DEMO_FILE = fileURLToPath(new URL("../../demo/results.json", import.meta.url));
const SCHEMA_FILE = fileURLToPath(
  new URL(`../../../core/schema/result.v${RESULT_SCHEMA_VERSION}.json`, import.meta.url),
);
const demoText = () => readFileSync(DEMO_FILE, "utf8");

/** A client folder that also holds the example results, as the built CLI's does. */
const demoClient = (text = demoText()) => scratchClientDir({ ...SAMPLE_FILES, [DEMO_PATH]: text });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  vi.restoreAllMocks();
});
const track = <T extends { close(): Promise<void> }>(t: T): T => (closers.push(() => t.close()), t);

/** A server on 127.0.0.1 with a chosen answer. `hold` keeps the first request open. */
async function stub(answer: (res: ServerResponse) => void) {
  const s = createServer((_q, res) => answer(res));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  closers.push(
    () =>
      new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("the report route: unit", () => {
  it("the headers: a constant file name, no store, and the sandbox policy in place of the app's", () => {
    expect(reportHeaders()).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="gaugeline-report.html"',
      "cache-control": "no-store",
      "content-security-policy": "sandbox",
    });
    expect(REPORT_FILENAME).toBe("gaugeline-report.html");
    expect(REPORT_POLICY).toBe("sandbox");
  });

  it("the budget is read back from the result's sampled record, kind by kind", () => {
    const summary = budgetOf({ links: { seen: 112, taken: 30, limit: 30 } });
    expect(summary.links).toEqual({ limit: 30, sampled: 30, found: 112 });
    expect(summary.images).toEqual({ limit: 0, sampled: 0, found: 0 });
  });

  it("a run with no report renders nothing", () => {
    const run = createStore().add("https://shop.example/");
    expect(renderRunReport(run, createPageRegistry(), "1.0.0")).toBeUndefined();
  });
});

describe("the demo store: unit", () => {
  it("loads results.json, and every run validates against the versioned JSON schema", () => {
    const runs = parseDemo(demoText());
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as object);
    for (const run of runs) {
      expect(validate(run.result), JSON.stringify(validate.errors)).toBe(true);
      expect(() => parseResult(run.result)).not.toThrow();
    }
    const store = createStore();
    fillDemo(store, runs);
    expect(store.list().map((r) => r.state)).toEqual(runs.map(() => "done"));
    expect(store.list().every((r) => r.report !== undefined)).toBe(true);
  });

  it("uses only invented addresses: *.example names, never a local address or a real site", () => {
    const text = demoText();
    expect(text).not.toMatch(/127\.0\.0\.1|localhost|::1/);
    const hosts = new Set(
      [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => (m[1] ?? "").toLowerCase()),
    );
    // The hosts the fixtures themselves invent are allowed beside the .example ones.
    for (const h of hosts)
      expect(h, h).toMatch(
        /\.example$|\.test$|^schema\.org$|^mo7h1an7\.api\.sanity\.io$|^moth-lantern-git-menu-studio\.vercel\.app$/,
      );
  });

  it("results.json from an older schema version: a clear error naming the command to rerun", () => {
    const old = JSON.parse(demoText()) as { resultSchema: number };
    old.resultSchema = RESULT_SCHEMA_VERSION - 1;
    expect(() => parseDemo(JSON.stringify(old))).toThrow(DemoError);
    expect(() => parseDemo(JSON.stringify(old))).toThrow(
      /out of date.*result schema 1.*pnpm demo:build/s,
    );
    const stale = JSON.parse(demoText()) as { runs: { result: { schema: number } }[] };
    stale.runs[0]!.result.schema = 1;
    expect(() => parseDemo(JSON.stringify(stale))).toThrow(/Example run 1 is not a valid result/);
    expect(() => parseDemo("{nope")).toThrow(/not valid JSON/);
    expect(() => parseDemo(JSON.stringify({ demo: DEMO_FILE_VERSION + 1 }))).toThrow(
      /another layout/,
    );
  });

  it("an app started on a stale file does not listen, and says what to run", async () => {
    const old = JSON.parse(demoText()) as { resultSchema: number };
    old.resultSchema = 1;
    await expect(
      startApp({ clientDir: demoClient(JSON.stringify(old)), demo: true }),
    ).rejects.toThrow(/pnpm demo:build/);
  });

  it("the demo takes no address, and needs the file in the client folder", async () => {
    await expect(
      startApp({ clientDir: demoClient(), demo: true, address: "shop.example" }),
    ).rejects.toThrow(DemoError);
    await expect(startApp({ clientDir: scratchClientDir(), demo: true })).rejects.toThrow(
      /not in this package/,
    );
  });
});

describe("the report route: integration", () => {
  it("equals renderReport's text byte for byte, and the file the CLI writes for the same fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-report-"));
    closers.push(async () =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    );
    const now = () => new Date("2026-11-07T03:00:00Z");
    for (const name of ["pages-search", "clean"]) {
      const site = await startFixture(name);
      closers.push(() => site.close());
      const c = await client({ now, version: VERSION });
      track(c.app);
      const id = String((await c.call("POST", "/api/check", { url: site.origin })).json().id);
      await c.finished(id);
      const download = await c.call("GET", `/api/runs/${id}/report`);
      expect(download.status).toBe(200);
      const { main } = await import("../../../cli/src/main.js");
      await main(
        [site.origin, "--allow-private", "--no-open", "--quiet"],
        { stdout: { write: () => undefined }, stderr: { write: () => undefined }, env: {}, now },
        { cwd: dir },
      );
      const file = readFileSync(join(dir, "gaugeline-report.html"));
      expect(download.bytes.equals(file), name).toBe(true);
      expect(header(download.head, "content-length")).toBe(String(file.length));
    }
  });

  it("the headers on the wire: one policy, and it is the sandbox; the rest of the app's headers stay", async () => {
    const site = await startFixture("clean");
    closers.push(() => site.close());
    const k = await client();
    track(k.app);
    const id = String((await k.call("POST", "/api/check", { url: site.origin })).json().id);
    await k.finished(id);
    const r = await k.call("GET", `/api/runs/${id}/report`);
    expect(header(r.head, "content-type")).toBe("text/html; charset=utf-8");
    expect(header(r.head, "content-disposition")).toBe(
      'attachment; filename="gaugeline-report.html"',
    );
    expect(header(r.head, "cache-control")).toBe("no-store");
    expect(header(r.head, "content-security-policy")).toBe("sandbox");
    expect(header(r.head, "x-content-type-options")).toBe("nosniff");
    expect(header(r.head, "referrer-policy")).toBe("no-referrer");
    // The app's own pages keep their strict policy: the report route changed nothing for them.
    const index = await k.call("GET", "/");
    expect(header(index.head, "content-security-policy")).toContain("default-src 'none'");
    expect(r.body).toContain("<style>");
    expect(r.body).not.toMatch(/<script|<link|https?:\/\/[^"' ]*\.(js|css)/);
  });

  it("a title with quotes and a newline, and a hostile address, never reach a header", async () => {
    const origin = await stub((res) =>
      res
        .writeHead(200, { "content-type": "text/html" })
        .end('<!doctype html><title>Joe\'s "Best"\r\nSet-Cookie: gl=1\nBar</title><h1>Hi</h1>'),
    );
    const k = await client();
    track(k.app);
    const id = String(
      (await k.call("POST", "/api/check", { url: `${origin}/a%22b%0D%0AX-Evil:1?q="x"` })).json()
        .id,
    );
    await k.finished(id);
    const r = await k.call("GET", `/api/runs/${id}/report`);
    expect(r.status).toBe(200);
    expect(header(r.head, "content-disposition")).toBe(
      'attachment; filename="gaugeline-report.html"',
    );
    expect(r.head).not.toMatch(/Best|Joe|X-Evil|Set-Cookie|a%22b/i);
    expect(header(r.head, "set-cookie")).toBeUndefined();
    expect(r.head.split("\r\n").length).toBeLessThan(14);
  });

  it("a run that is still going: 409; an unknown id: 404; without the cookie: 403", async () => {
    const origin = await stub(() => undefined);
    const k = await client();
    track(k.app);
    const id = String((await k.call("POST", "/api/check", { url: origin })).json().id);
    const running = await k.call("GET", `/api/runs/${id}/report`);
    expect(running.status).toBe(409);
    expect(running.json().error).toMatch(/still running/);
    expect(header(running.head, "content-disposition")).toBeUndefined();
    const missing = await k.call("GET", "/api/runs/nope/report");
    expect(missing.status).toBe(404);
    const noCookie = await raw(k.app.port, [
      `GET /api/runs/${id}/report HTTP/1.1`,
      `Host: ${k.host}`,
    ]);
    expect(noCookie.status).toBe(403);
    expect(noCookie.body).not.toContain("<html");
    const wrongMethod = await k.call("POST", `/api/runs/${id}/report`, {});
    expect(wrongMethod.status).toBe(405);
  });

  it("a run that could not run: 409 with a sentence, and no file", async () => {
    const origin = await stub((res) =>
      res.writeHead(302, { location: "http://169.254.169.254/" }).end(),
    );
    const k = await client();
    track(k.app);
    const id = String((await k.call("POST", "/api/check", { url: origin })).json().id);
    await k.finished(id);
    const r = await k.call("GET", `/api/runs/${id}/report`);
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/did not finish/);
  });
});

describe("the demo: integration", () => {
  it("GET /api/runs lists the example runs, all done; each has a result and a downloadable report", async () => {
    const k = await client({ clientDir: demoClient(), demo: true, version: "9.9.9" });
    track(k.app);
    const list = JSON.parse((await k.call("GET", "/api/runs")).body) as {
      id: string;
      url: string;
      state: string;
    }[];
    expect(list.map((r) => r.url)).toEqual([
      "https://tavern.example/",
      "https://wine-bar.example/",
      "https://shop.example/",
    ]);
    expect(list.every((r) => r.state === "done")).toBe(true);
    for (const r of list) {
      const one = (await k.call("GET", `/api/runs/${r.id}`)).json();
      expect(one.result).toBeDefined();
      expect(one.checked).toBeDefined();
      const report = await k.call("GET", `/api/runs/${r.id}/report`);
      expect(report.status).toBe(200);
      expect(report.body).toContain(new URL(r.url).host);
      expect(report.body).toContain("Gaugeline 9.9.9");
      expect(report.body).not.toContain("failed to run");
    }
    expect((await k.call("GET", "/api/session")).json()).toEqual({ demo: true, version: "9.9.9" });
  });

  it("POST /api/check: 409 with the sentence, whatever is asked; nothing is added", async () => {
    const k = await client({ clientDir: demoClient(), demo: true });
    track(k.app);
    const before = k.app.store.list().length;
    for (const body of [{ url: "yoursite.com" }, { nope: 1 }]) {
      const r = await k.call("POST", "/api/check", body);
      expect(r.status).toBe(409);
      expect(r.json()).toEqual({ error: DEMO_SENTENCE });
    }
    expect(DEMO_SENTENCE).toBe(
      "This is the demo. Run npx gaugeline open yoursite.com to check a real page.",
    );
    expect(k.app.store.list()).toHaveLength(before);
  });

  it("the example file is data: it is never served as a file of the app", async () => {
    const k = await client({ clientDir: demoClient(), demo: true });
    track(k.app);
    expect((await k.call("GET", `/${DEMO_PATH}`)).status).toBe(404);
  });

  it("a normal session says so", async () => {
    const k = await client({ version: "1.2.3" });
    track(k.app);
    expect((await k.call("GET", "/api/session")).json()).toEqual({ demo: false, version: "1.2.3" });
  });

  it("the key, cookie and Host rules are the same in demo mode", async () => {
    const app = track(await startApp({ clientDir: demoClient(), demo: true }));
    const host = `localhost:${app.port}`;
    // Without the key or a cookie: refused. A wrong Host: refused. The link works once.
    expect((await raw(app.port, ["GET /api/runs HTTP/1.1", `Host: ${host}`])).status).toBe(403);
    const search = new URL(app.url).search;
    expect((await raw(app.port, [`GET /${search} HTTP/1.1`, "Host: evil.example"])).status).toBe(
      403,
    );
    const first = await raw(app.port, [`GET /${search} HTTP/1.1`, `Host: ${host}`]);
    expect(first.status).toBe(303);
    const cookie = /^set-cookie: ([^;]+)/im.exec(first.head)?.[1] ?? "";
    expect((await raw(app.port, [`GET /${search} HTTP/1.1`, `Host: ${host}`])).status).toBe(403);
    const rebound = await raw(app.port, [
      "GET /api/runs HTTP/1.1",
      "Host: evil.example",
      `Cookie: ${cookie}`,
    ]);
    expect(rebound.status).toBe(403);
    const cross = await raw(
      app.port,
      [
        "POST /api/check HTTP/1.1",
        `Host: ${host}`,
        `Cookie: ${cookie}`,
        "Origin: https://evil.example",
        "Content-Type: application/json",
      ],
      "{}",
    );
    expect(cross.status).toBe(403);
    expect(
      (await raw(app.port, ["GET /api/runs HTTP/1.1", `Host: ${host}`, `Cookie: ${cookie}`]))
        .status,
    ).toBe(200);
  });
});

describe("edge cases", () => {
  it("a result with 500 findings: the download stays under 2 MB", async () => {
    const runs = JSON.parse(demoText()) as {
      runs: { result: { findings: unknown[] } }[];
    };
    const first = runs.runs[0]!;
    const one = first.result.findings[0]!;
    first.result.findings = Array.from({ length: 500 }, () => one);
    const k = await client({ clientDir: demoClient(JSON.stringify(runs)), demo: true });
    track(k.app);
    const list = JSON.parse((await k.call("GET", "/api/runs")).body) as { id: string }[];
    const r = await k.call("GET", `/api/runs/${list[0]!.id}/report`);
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(r.bytes.length).toBeGreaterThan(100_000);
  });
});

describe("promise: in demo mode the process opens no outbound socket", () => {
  it("net.connect and tls.connect refuse any host but 127.0.0.1 while the whole flow runs; no fetch is made", async () => {
    const seen: string[] = [];
    const guard =
      (real: (...a: never[]) => unknown) =>
      (...args: unknown[]) => {
        const first = args[0] as { host?: string } | number | string | undefined;
        const second = args[1] as string | undefined;
        const host =
          typeof first === "object" && first !== null
            ? (first.host ?? "")
            : typeof second === "string"
              ? second
              : "";
        seen.push(host);
        if (host !== "127.0.0.1") throw new Error(`outbound connection to "${host}" refused`);
        return (real as (...a: unknown[]) => unknown)(...args);
      };
    vi.spyOn(net, "connect").mockImplementation(guard(net.connect.bind(net) as never) as never);
    vi.spyOn(net, "createConnection").mockImplementation(
      guard(net.createConnection.bind(net) as never) as never,
    );
    vi.spyOn(tls, "connect").mockImplementation(guard(tls.connect.bind(tls) as never) as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const k = await client({ clientDir: demoClient(), demo: true });
    track(k.app);
    const list = JSON.parse((await k.call("GET", "/api/runs")).body) as { id: string }[];
    for (const r of list) {
      await k.call("GET", `/api/runs/${r.id}`);
      await k.call("GET", `/api/runs/${r.id}/report`);
    }
    await k.call("GET", "/api/session");
    expect((await k.call("POST", "/api/check", { url: "yoursite.com" })).status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The only sockets were this test's own, to 127.0.0.1.
    expect(seen.every((h) => h === "127.0.0.1")).toBe(true);
  });
});
