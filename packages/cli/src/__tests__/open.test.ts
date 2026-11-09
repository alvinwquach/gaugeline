import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { startFixture } from "@gaugeline/fixtures";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bin } from "./helpers/bin.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `gaugeline-open-${name}-`));
  dirs.push(d);
  return d;
};

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const opts = { agent: false, autoSelectFamily: true } as Parameters<typeof httpRequest>[1];
    const req = httpRequest(url, opts, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
const hold = (port: number) =>
  new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port }, () => resolve(s));
  });
const release = (s: Server) => new Promise<void>((r) => s.close(() => r()));

/** The built bin, `gaugeline open --no-open`, with its own home and working folder. */
function open(env: Record<string, string> = {}, extra: string[] = []) {
  const home = scratch("home");
  const cwd = scratch("cwd");
  // Its own temp folder too: the shared one fills with other test files' folders meanwhile.
  const tmp = scratch("tmp");
  const child = spawn(process.execPath, [bin, "open", ...extra, "--no-open"], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      CI: "",
      NO_COLOR: "1",
      ...env,
    },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const url = new Promise<string>((resolve, reject) => {
    const t = setInterval(() => {
      const m = /Gaugeline is running at (http:\/\/localhost:\d+\/\?s=\S+)/.exec(out);
      if (m?.[1]) {
        clearInterval(t);
        resolve(m[1]);
      }
    }, 20);
    void exited.then(() => {
      clearInterval(t);
      reject(new Error(`exited before printing an address: ${err}`));
    });
  });
  return { child, url, exited, home, cwd, tmp, out: () => out, err: () => err };
}

/** Every file under a folder, with its mtime. */
function files(dir: string): { path: string; mtime: number }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
      return { path, mtime: statSync(path).mtimeMs };
    });
}

const POSIX = process.platform !== "win32";

/** A raw GET to 127.0.0.1 with the Host (and cookie) a browser would send. */
function rawGet(
  port: number,
  path: string,
  host: string,
  cookie = "",
): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, () =>
      c.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}Connection: close\r\n\r\n`,
      ),
    );
    let data = "";
    c.on("data", (d: Buffer) => (data += d.toString()));
    c.on("end", () => {
      const i = data.indexOf("\r\n\r\n");
      resolve({ head: data.slice(0, i), body: data.slice(i + 4) });
    });
    c.on("error", reject);
  });
}

describe("gaugeline open: e2e (the built bin)", () => {
  it.skipIf(!POSIX)(
    "prints the address, answers it, and Ctrl+C exits 0 leaving nothing behind",
    async () => {
      const started = Date.now();
      const run = open({ DEBUG: "*" });
      const url = await run.url;
      expect(url).toMatch(/^http:\/\/localhost:\d+\/\?s=[A-Za-z0-9_-]{43}$/);
      expect(await get(url)).toBe(303);
      run.child.kill("SIGINT");
      expect(await run.exited).toBe(0);
      const key = new URL(url).searchParams.get("s") ?? "";
      // The key: exactly once in stdout, never in stderr, even with DEBUG set.
      expect(run.out().split(key).length - 1).toBe(1);
      expect(run.err()).not.toContain(key);
      expect(run.out()).toContain("It's only reachable from this computer. Press Ctrl+C to stop.");
      // Nothing saved: no file in the working folder, the temp folder or (newer than the start) home.
      expect(files(run.cwd)).toEqual([]);
      expect(files(run.home).filter((f) => f.mtime >= started)).toEqual([]);
      expect(readdirSync(run.tmp)).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    "a second Ctrl+C during shutdown neither throws nor prints a stack trace",
    async () => {
      const run = open();
      await run.url;
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        run.child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      run.child.kill("SIGINT");
      run.child.kill("SIGINT");
      // The first signal starts the shutdown and the handler stays for the second. If the shutdown is
      // fast enough that the second one arrives while Node is already tearing down, after it has put
      // the default action back, the process ends by that signal instead: any program does. Either
      // way it ends at once, without an error.
      const { code, signal } = await ended;
      expect(code === 0 || (code === null && signal === "SIGINT")).toBe(true);
      expect(run.err()).not.toMatch(/Error|at .+:\d+:\d+/);
    },
  );

  it.skipIf(!POSIX)(
    "Ctrl+C the instant the link appears still exits 0 (handlers are in place first)",
    async () => {
      const codes: (number | string | null)[] = [];
      for (let i = 0; i < 5; i++) {
        const child = spawn(process.execPath, [bin, "open", "--no-open"], {
          cwd: scratch("race"),
          env: { ...process.env, CI: "", NO_COLOR: "1" },
        });
        codes.push(
          await new Promise((resolve) => {
            child.stdout.on("data", (d: Buffer) => {
              if (d.toString().includes("running at")) child.kill("SIGINT");
            });
            child.on("exit", (code, signal) => resolve(code ?? signal));
          }),
        );
      }
      expect(codes).toEqual([0, 0, 0, 0, 0]);
    },
  );

  it.skipIf(!POSIX)(
    "gaugeline open <address> prints the progress lines, then the link; /api/runs has one finished run",
    async () => {
      const site = await startFixture("clean");
      const run = open({}, [site.origin]);
      try {
        const url = await run.url;
        const before = run.out().slice(0, run.out().indexOf("Gaugeline is running at"));
        expect(before.trimEnd().split("\n")).toEqual([
          " Loading the page without JavaScript",
          " Reading robots.txt and the sitemap",
          " Checking 2 links on the page",
          " Scanning the site's JavaScript for leaked keys",
        ]);
        const u = new URL(url);
        const host = `localhost:${u.port}`;
        const link = await rawGet(Number(u.port), `/${u.search}`, host);
        const cookie = /^set-cookie: ([^;]+)/im.exec(link.head)?.[1] ?? "";
        const runs = JSON.parse((await rawGet(Number(u.port), "/api/runs", host, cookie)).body) as {
          state: string;
          url: string;
        }[];
        expect(runs.map((r) => r.state)).toEqual(["done"]);
      } finally {
        run.child.kill("SIGINT");
        await run.exited;
        await site.close();
      }
    },
  );

  it("4817 held by another program: stdout shows 4818 and that address answers", async () => {
    const held = await hold(4817).catch(() => undefined);
    const run = open();
    try {
      const url = await run.url;
      if (held) expect(new URL(url).port).toBe("4818");
      expect(await get(url)).toBe(303);
    } finally {
      run.child.kill(POSIX ? "SIGINT" : "SIGTERM");
      await run.exited;
      if (held) await release(held);
    }
  });

  it("ports 4817 to 4826 all busy: exit 2 and a message naming the range", async () => {
    const held = await Promise.all(Array.from({ length: 10 }, (_, i) => hold(4817 + i)));
    try {
      const run = open();
      await run.url.catch(() => undefined);
      expect(await run.exited).toBe(2);
      expect(run.err()).toContain("Ports 4817 to 4826 are all in use");
      expect(run.out()).not.toContain("?s=");
    } finally {
      await Promise.all(held.map(release));
    }
  });
});
