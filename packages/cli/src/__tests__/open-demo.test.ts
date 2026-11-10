import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";
import { FLAGS } from "../flags.js";
import { bin } from "./helpers/bin.js";

const POSIX = process.platform !== "win32";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const scratch = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `gaugeline-demo-${name}-`));
  dirs.push(d);
  return d;
};

describe("gaugeline open --demo: argument parsing (unit)", () => {
  it("--demo alone is the demo, with no address", () => {
    expect(parseCliArgs(["open", "--demo"])).toMatchObject({ kind: "open", demo: true });
    expect(parseCliArgs(["open", "--demo"])).not.toHaveProperty("address");
    expect(parseCliArgs(["open"])).toMatchObject({ kind: "open", demo: false });
    expect(parseCliArgs(["open", "--demo", "--no-open"])).toMatchObject({
      demo: true,
      noOpen: true,
    });
  });

  it("--demo with an address is a usage error", async () => {
    expect(parseCliArgs(["open", "--demo", "shop.example"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("takes no address"),
    });
    const c = capture();
    expect(await main(["open", "--demo", "shop.example"], c.io)).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("gaugeline open --demo takes no address");
    expect(c.out()).toBe("");
  });

  it("--demo with --ads is a usage error (exit 2) with its own sentence", async () => {
    const c = capture();
    expect(await main(["open", "--demo", "--ads", "ads-export.csv"], c.io)).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("--demo and --ads cannot be used together");
    expect(c.out()).toBe("");
  });

  it("--demo belongs to open alone: other commands refuse it, and --help lists it for open", async () => {
    for (const argv of [
      ["example.com", "--demo"],
      ["launch", "example.com", "--demo"],
    ]) {
      expect(parseCliArgs(argv)).toMatchObject({ kind: "error" });
    }
    const flag = FLAGS.find((f) => f.name === "demo");
    expect(flag).toMatchObject({ type: "boolean", commands: ["open"] });
    const c = capture();
    expect(await main(["open", "--help"], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain("--demo");
    expect(c.out()).toContain("example results");
  });
});

function get(
  link: string,
  path: string,
  cookie = "",
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(link);
    const opts: RequestOptions = {
      host: "127.0.0.1",
      port: u.port,
      path,
      agent: false,
      headers: { host: u.host, ...(cookie ? { cookie } : {}) },
    };
    const req = httpRequest(opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("gaugeline open --demo: the built bin (e2e)", () => {
  it("serves the example results and opens no outbound socket", async () => {
    const dir = scratch("run");
    const log = join(dir, "sockets.log");
    // Loaded before the program: every net.connect and tls.connect is written to a file, and any
    // host but 127.0.0.1 throws, as it would if the demo tried to reach a site.
    const preload = join(dir, "no-outbound.cjs");
    writeFileSync(
      preload,
      [
        'const fs = require("node:fs"), net = require("node:net"), tls = require("node:tls");',
        `const log = ${JSON.stringify(log)};`,
        "const hostOf = (a) => (a[0] && typeof a[0] === 'object' ? a[0].host : typeof a[1] === 'string' ? a[1] : '');",
        "for (const [mod, name] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {",
        "  const real = mod[name];",
        "  mod[name] = function (...a) {",
        "    const h = hostOf(a);",
        "    fs.appendFileSync(log, String(h) + '\\n');",
        "    if (h !== '127.0.0.1') throw new Error('outbound connection to ' + h);",
        "    return real.apply(this, a);",
        "  };",
        "}",
      ].join("\n"),
    );
    const child = spawn(
      process.execPath,
      ["--require", preload, bin, "open", "--demo", "--no-open"],
      {
        cwd: dir,
        env: { ...process.env, CI: "", NO_COLOR: "1" },
      },
    );
    children.push(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    const link = await new Promise<string>((resolve, reject) => {
      const t = setInterval(() => {
        const m = /Gaugeline is running at (http:\/\/localhost:\d+\/\?s=\S+)/.exec(out);
        if (m?.[1]) {
          clearInterval(t);
          resolve(m[1]);
        }
      }, 20);
      void exited.then(() => {
        clearInterval(t);
        reject(new Error(`exited before the link: ${err}`));
      });
    });
    expect(out).toContain("This is the demo: example results about invented sites.");
    const u = new URL(link);
    const entered = await get(link, `/${u.search}`);
    expect(entered.status).toBe(303);
    const cookie = String(entered.headers["set-cookie"]).split(";")[0] ?? "";
    expect(JSON.parse((await get(link, "/api/session", cookie)).body)).toMatchObject({
      demo: true,
    });
    const runs = JSON.parse((await get(link, "/api/runs", cookie)).body) as {
      id: string;
      state: string;
    }[];
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const report = await get(link, `/api/runs/${runs[0]?.id}/report`, cookie);
    expect(report.status).toBe(200);
    expect(report.headers["content-disposition"]).toBe(
      'attachment; filename="gaugeline-report.html"',
    );
    expect(report.headers["content-security-policy"]).toBe("sandbox");
    const asked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: u.port,
          path: "/api/check",
          method: "POST",
          agent: false,
          headers: {
            host: u.host,
            origin: `http://${u.host}`,
            cookie,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ url: "yoursite.com" }));
    });
    expect(asked).toBe(409);
    child.kill(POSIX ? "SIGINT" : undefined);
    const code = await exited;
    if (POSIX) expect(code).toBe(0);
    // The only sockets this process made were its own listener's peers: none to another host.
    let hosts: string[] = [];
    try {
      hosts = readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      // no outbound attempt at all: the file was never written
    }
    expect(hosts.filter((h) => h !== "127.0.0.1")).toEqual([]);
    expect(err).not.toMatch(/outbound connection/);
  });

  it("--demo with an address exits 2 with one sentence and starts nothing", async () => {
    const child = spawn(process.execPath, [bin, "open", "--demo", "shop.example", "--no-open"], {
      cwd: scratch("addr"),
      env: { ...process.env, CI: "", NO_COLOR: "1" },
    });
    children.push(child);
    let err = "";
    let out = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(2);
    expect(err).toContain("takes no address");
    expect(out).toBe("");
  });
});
