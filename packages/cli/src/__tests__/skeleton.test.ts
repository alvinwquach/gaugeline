import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPageRegistry } from "@gaugeline/core";
import { checkTagVersion } from "../../../../scripts/check-tag-version.js";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { main } from "../main.js";
import { SKELETON_CHECKS, skeletonOnly } from "../skeleton.js";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliDir = join(repoRoot, "packages/cli");
const words = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
const page = (canonical: string, head = "") =>
  `<html><head><title>Fixture Shop</title><link rel="canonical" href="${canonical}">${head}</head><body><main><p>${words}</p></main></body></html>`;

let site: FixtureServer;
let closedOrigin = "";
let packDir = "";
let tarball = "";
beforeAll(async () => {
  site = await startServer({
    "/wrong": (_q, res) =>
      void res.writeHead(200, { "content-type": "text/html" }).end(page("https://other.example/")),
    "/clean": (_q, res) =>
      void res.writeHead(200, { "content-type": "text/html" }).end(page(`${site.origin}/clean`)),
    "/both": (_q, res) =>
      void res
        .writeHead(200, { "content-type": "text/html" })
        .end(page("https://other.example/", '<meta name="robots" content="noindex">')),
  });
  const closed = await startServer({});
  closedOrigin = closed.origin;
  await closed.close();
  packDir = mkdtempSync(join(tmpdir(), "gaugeline-k01-"));
  await exec("npm", ["pack", "--pack-destination", packDir], {
    cwd: cliDir,
    shell: process.platform === "win32",
  });
  tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz")) ?? "");
}, 60_000);
afterAll(async () => {
  await site.close();
  rmSync(packDir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  return {
    io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } },
    out: () => out.join(""),
  };
}

describe("walking skeleton: unit", () => {
  it("SKELETON_CHECKS contains only ids that exist in the registry", () => {
    const registry = createPageRegistry();
    expect(SKELETON_CHECKS.length).toBeGreaterThan(0);
    for (const id of SKELETON_CHECKS) expect(registry.has(id), id).toBe(true);
  });

  it("with version 0.0.x the CLI runs only SKELETON_CHECKS; with 0.1.0 it runs everything", async () => {
    expect(skeletonOnly("0.0.2")).toEqual(["canonical-elsewhere"]);
    expect(skeletonOnly("0.0.2-beta.1")).toEqual(["canonical-elsewhere"]);
    expect(skeletonOnly("0.1.0")).toBeUndefined();
    const skeleton = capture();
    await main([`${site.origin}/both`, "--json", "--allow-private"], skeleton.io, {
      version: "0.0.2",
    });
    const s = JSON.parse(skeleton.out()) as { findings: { checkId: string }[]; passed: string[] };
    expect(s.findings.map((f) => f.checkId)).toEqual(["canonical-elsewhere"]);
    expect(s.passed).toEqual([]);
    const full = capture();
    await main([`${site.origin}/both`, "--json", "--allow-private"], full.io, { version: "0.1.0" });
    const f = JSON.parse(full.out()) as { findings: { checkId: string }[] };
    // The test server has no sitemap, which the full catalogue reports too.
    expect(f.findings.map((x) => x.checkId).sort()).toEqual([
      "canonical-elsewhere",
      "noindex",
      "og-image-missing",
      "sitemap-missing",
      "viewport",
    ]);
  });
});

describe("walking skeleton: integration (the packed tarball)", () => {
  it("npm pack lists dist (the bundle and the embedded client), README.md, LICENSE, THIRD_PARTY_LICENSES.md, package.json and nothing else", async () => {
    const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
      cwd: cliDir,
      shell: process.platform === "win32",
    });
    const [info] = JSON.parse(stdout) as [{ files: { path: string }[] }];
    // The client's file names carry content hashes, so they come from its manifest: every file the
    // manifest lists, the manifest itself, and nothing else under dist/client.
    const manifest = JSON.parse(
      readFileSync(join(cliDir, "dist/client/client-manifest.json"), "utf8"),
    ) as { path: string }[];
    expect(info.files.map((f) => f.path).sort()).toEqual(
      [
        "LICENSE",
        "README.md",
        "THIRD_PARTY_LICENSES.md",
        "dist/index.js",
        "dist/client/client-manifest.json",
        ...manifest.map((e) => `dist/client/${e.path}`),
        "package.json",
      ].sort(),
    );
  });

  it("the tarball installed into an empty temp directory runs --help and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-install-"));
    try {
      await exec("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
        cwd: dir,
        shell: process.platform === "win32",
      });
      const { stdout } = await exec(process.execPath, [
        join(dir, "node_modules/gaugeline/dist/index.js"),
        "--help",
      ]);
      expect(stdout).toContain("Usage: gaugeline <address> [options]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

const bash = process.platform !== "win32";
/**
 * The parent environment without the npm_config_* variables that pnpm sets for its scripts.
 * npm 11 (Node 24) warns on stderr about the ones it does not know, and the smoke script runs
 * npx in a clean directory, so it should not inherit them anyway.
 */
function cleanParentEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
  );
}

function smoke(env: Record<string, string>, version = "0.0.2") {
  return exec("bash", [join(repoRoot, "scripts/smoke-published.sh"), version], {
    env: { ...cleanParentEnv(), CI: "", SMOKE_RUNNER: "local", SMOKE_RETRY_SECONDS: "0", ...env },
  }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );
}

describe.runIf(bash)(
  "smoke-published.sh: e2e (local runner, packed tarball, fixture pages)",
  () => {
    it("wrong canonical, --ci, clean and unreachable all behave as published", async () => {
      site.log.length = 0;
      const r = await smoke({
        SMOKE_PACKAGE: tarball,
        SMOKE_WRONG_URL: `${site.origin}/wrong`,
        SMOKE_CLEAN_URL: `${site.origin}/clean`,
        SMOKE_UNREACHABLE_URL: closedOrigin,
        SMOKE_EXTRA_ARGS: "--allow-private",
      });
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("passed (wrong canonical, --ci, clean, unreachable)");
      // Promise test: the smoke run only ever sends GET or HEAD.
      expect(site.log.length).toBeGreaterThan(0);
      expect(site.log.every((l) => l.method === "GET" || l.method === "HEAD")).toBe(true);
    }, 120_000);

    it("a wrong expectation fails with the reason", async () => {
      const r = await smoke({
        SMOKE_PACKAGE: tarball,
        SMOKE_WRONG_URL: `${site.origin}/clean`,
        SMOKE_CLEAN_URL: `${site.origin}/clean`,
        SMOKE_EXTRA_ARGS: "--allow-private",
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("expected one canonical-elsewhere finding");
    }, 60_000);
  },
);

describe.runIf(bash)("smoke-published.sh: edge cases", () => {
  it("the registry never catches up: retries, then fails naming the version it wanted", async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "gaugeline-fake-npm-"));
    try {
      writeFileSync(join(fakeBin, "npm"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(fakeBin, "npm"), 0o755);
      const r = await smoke(
        {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SMOKE_WRONG_URL: "http://x.invalid/",
          SMOKE_CLEAN_URL: "http://y.invalid/",
          SMOKE_RETRIES: "5",
        },
        "9.9.9",
      );
      expect(r.code).toBe(1);
      expect(r.stderr.match(/is not on the registry yet/g)).toHaveLength(5);
      expect(r.stderr).toContain("gaugeline@9.9.9 never appeared on the registry after 5 tries");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("missing page addresses are refused before anything runs", async () => {
    const r = await smoke({ SMOKE_PACKAGE: tarball });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("set SMOKE_WRONG_URL");
  });
});

describe("tag and version", () => {
  it("a tag v0.0.3 on a commit whose package.json says 0.0.2 fails before publishing, naming both", () => {
    expect(checkTagVersion("v0.0.3", "0.0.2")).toEqual({
      ok: false,
      message: "Tag v0.0.3 says 0.0.3 but packages/cli/package.json says 0.0.2. Not publishing.",
    });
    expect(checkTagVersion("v0.0.2", "0.0.2")).toEqual({ ok: true });
    expect(checkTagVersion("refs/tags/v0.0.2", "0.0.2")).toEqual({ ok: true });
  });
});
