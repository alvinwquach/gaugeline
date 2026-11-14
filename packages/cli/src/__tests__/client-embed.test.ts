import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultClientDir } from "../client-dir.js";
import { bin } from "./helpers/bin.js";

const exec = promisify(execFile);
const cliDir = fileURLToPath(new URL("../../", import.meta.url));
const distClient = join(cliDir, "dist/client");
const preload = fileURLToPath(new URL("./helpers/record-connections.cjs", import.meta.url));
const shell = process.platform === "win32";
const POSIX = process.platform !== "win32";

const dirs: string[] = [];
const scratch = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `gaugeline-embed-${name}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The parent environment without the npm_config_* variables pnpm sets (npm 11 warns on them). */
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")),
  ),
  CI: "",
  NO_COLOR: "1",
  ...extra,
});

interface Manifest {
  path: string;
  type: string;
  bytes: number;
  gzipBytes: number;
  sha256: string;
}
const manifest = () =>
  JSON.parse(readFileSync(join(distClient, "client-manifest.json"), "utf8")) as Manifest[];

/** `open --no-open` for a given CLI file; resolves with the link once printed, or the exit. */
function openFile(file: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    [...(env.PRELOAD ? ["--require", env.PRELOAD] : []), file, "open", "--no-open"],
    {
      cwd: scratch("cwd"),
      env: cleanEnv(env),
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const link = new Promise<string>((resolve, reject) => {
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
  link.catch(() => undefined);
  return { child, exited, link, out: () => out, err: () => err };
}

function get(
  url: string,
  cookie = "",
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const opts = {
      agent: false,
      autoSelectFamily: true,
      headers: cookie ? { cookie } : {},
    } as Parameters<typeof httpRequest>[1];
    const req = httpRequest(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("embedded client: the CLI's folder", () => {
  it("defaultClientDir: the folder beside the bundle, else the build's own, else beside (so the error names it)", () => {
    // Real absolute paths for this OS (a drive letter on Windows), turned into file URLs.
    const root = resolve(tmpdir(), "gaugeline-client-dir");
    const url = (...parts: string[]) => pathToFileURL(resolve(root, ...parts)).href;
    const same = (got: string, want: string) => expect(resolve(got)).toBe(resolve(want));
    const only =
      (...present: string[]) =>
      (p: string) =>
        present.some((x) => resolve(p) === resolve(x));
    const beside = resolve(root, "pkg", "dist", "client");
    same(defaultClientDir(url("pkg", "dist", "index.js"), only(beside)), beside);
    const fromSource = resolve(root, "repo", "packages", "cli", "dist", "client");
    same(
      defaultClientDir(url("repo", "packages", "cli", "src", "client-dir.ts"), only(fromSource)),
      fromSource,
    );
    // Neither exists: the folder beside the bundle, so the error can name it.
    same(
      defaultClientDir(url("pkg", "dist", "index.js"), () => false),
      beside,
    );
  });

  it("pnpm build left a client whose manifest matches its files", () => {
    expect(existsSync(distClient)).toBe(true);
    const entries = manifest();
    expect(entries.map((e) => e.path)).toContain("index.html");
    for (const e of entries)
      expect(Object.keys(e)).toEqual(["path", "type", "bytes", "gzipBytes", "sha256"]);
  });
});

describe("embedded client: the policy has nothing to block", () => {
  it("the built client has no eval, no new Function, no inline script and no style attribute", () => {
    for (const e of manifest()) {
      const text = readFileSync(join(distClient, e.path), "utf8");
      if (e.path.endsWith(".js"))
        expect(text, e.path).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
      if (e.path.endsWith(".html")) {
        expect(text, e.path).not.toMatch(/<script(?![^>]*\bsrc=)/i);
        expect(text, e.path).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
      }
      if (e.path.endsWith(".js") || e.path.endsWith(".css"))
        expect(text, e.path).not.toContain("sourceMappingURL");
    }
  });
});

/** The bundle without its client: dist/index.js and the chunks beside it (tsup splitting), not dist/client. */
function copyBundle(to: string): void {
  const from = join(bin, "..");
  for (const f of readdirSync(from))
    if (f.endsWith(".js")) copyFileSync(join(from, f), join(to, f));
}

describe("embedded client: edge cases (the built bin)", () => {
  it("dist/client missing (the CLI built alone): open exits 2 with one line and no stack trace", async () => {
    const alone = scratch("alone");
    copyBundle(alone);
    const run = openFile(join(alone, "index.js"));
    expect(await run.exited).toBe(2);
    expect(run.err()).toContain("the app was not built into this package");
    expect(run.err().trim().split("\n")).toHaveLength(1);
    expect(run.err()).not.toMatch(/\n\s+at |Error:/);
    expect(run.out()).toBe("");
  });

  it("a client that no longer matches its manifest: open exits 2 with one line and does not listen", async () => {
    const damaged = scratch("damaged");
    copyBundle(damaged);
    cpSync(distClient, join(damaged, "client"), { recursive: true });
    const js = manifest().find((e) => e.path.endsWith(".js"))?.path ?? "";
    // Same length, one byte different: the size matches, so only the hash can tell.
    const original = readFileSync(join(damaged, "client", js));
    original[0] = original[0] === 0x20 ? 0x21 : 0x20;
    writeFileSync(join(damaged, "client", js), original);
    const run = openFile(join(damaged, "index.js"));
    expect(await run.exited).toBe(2);
    expect(run.err()).toContain(`${js} has a different sha256 from the manifest`);
    expect(run.err()).not.toMatch(/\n\s+at /);
    expect(run.out()).toBe("");
  });
});

describe("embedded client: e2e (the packed tarball, no registry)", () => {
  let pack = "";
  let installed = "";
  beforeAll(async () => {
    pack = scratch("pack");
    await exec("npm", ["pack", "--pack-destination", pack], {
      cwd: cliDir,
      shell,
      env: cleanEnv(),
    });
    const name = readdirSync(pack).find((f) => f.endsWith(".tgz")) ?? "";
    expect(name).not.toBe("");
    const tarball = join(pack, name);
    installed = scratch("install");
    // The registry is a closed port: the tarball has no dependencies, so nothing may be fetched.
    await exec(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--registry",
        "http://127.0.0.1:1",
        "--fetch-retries",
        "0",
        tarball,
      ],
      { cwd: installed, shell, env: cleanEnv() },
    );
  }, 120_000);

  it("the installed package serves the client; the browser's requests are the app's own, and the app opens no connection", async () => {
    const log = join(scratch("log"), "connections.log");
    const file = join(installed, "node_modules/gaugeline/dist/index.js");
    const run = openFile(file, { PRELOAD: preload, GAUGELINE_RECORD_CONNECTIONS: log });
    try {
      const link = await run.link;
      const base = new URL(link);
      const opened = await get(link);
      expect(opened.status).toBe(303);
      const cookie = String(opened.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
      const page = await get(`${base.origin}/`, cookie);
      expect(page.status).toBe(200);
      expect(page.headers["cache-control"]).toBe("no-store");
      const html = page.body.toString("utf8");
      // Everything the page loads is a relative path in the manifest: no other host, no inline script.
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(refs.length).toBeGreaterThan(0);
      const listed = new Map(manifest().map((e) => [`/${e.path}`, e]));
      for (const ref of refs) {
        expect(ref, ref).toMatch(/^\.\/assets\//);
        const path = new URL(ref, `${base.origin}/`).pathname;
        expect(listed.has(path), path).toBe(true);
        const asset = await get(`${base.origin}${path}`, cookie);
        expect(asset.status, path).toBe(200);
        expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      }
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/i);
      expect(html).not.toMatch(/https?:\/\//);
      expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    } finally {
      if (POSIX) {
        // Ctrl+C: a clean stop, exit 0.
        run.child.kill("SIGINT");
        expect(await run.exited).toBe(0);
      } else {
        // On Windows kill("SIGINT") terminates the process and the exit code is null: just end it.
        run.child.kill();
        await run.exited;
      }
    }
    // The app itself opened no connection (the recorder logs every outbound socket).
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  }, 60_000);
});
