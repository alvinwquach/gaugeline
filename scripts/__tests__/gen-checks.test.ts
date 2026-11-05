import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPageRegistry } from "../../packages/core/src/index.js";
import { updateLock } from "../lib/check-ids.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function gen(env: Record<string, string>, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/gen-checks.ts"),
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}
function temp() {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-gen-"));
  temps.push(d);
  return d;
}

describe("gen-checks: integration", () => {
  it("running twice produces a byte-identical file", () => {
    const d = temp();
    const env = { GEN_CHECKS_DATA: join(d, "data.json"), GEN_CHECKS_LOCK: join(d, "lock.json") };
    expect(gen(env).status).toBe(0);
    const first = readFileSync(join(d, "data.json"), "utf8");
    expect(gen(env).status).toBe(0);
    expect(readFileSync(join(d, "data.json"), "utf8")).toBe(first);
  }, 30_000);

  it("the committed docs/checks.data.json is current", () => {
    expect(gen({}, ["--check"]).status).toBe(0);
  }, 30_000);

  it("every id in the registry is in docs/check-ids.lock.json", () => {
    const lock = JSON.parse(
      readFileSync(join(repoRoot, "docs/check-ids.lock.json"), "utf8"),
    ) as string[];
    for (const c of createPageRegistry().all()) expect(lock, c.id).toContain(c.id);
    expect([...lock].sort()).toEqual(lock);
  });

  it("the six checks from G05 appear with the wording from the published catalogue", () => {
    const data = JSON.parse(readFileSync(join(repoRoot, "docs/checks.data.json"), "utf8")) as {
      id: string;
      title: string;
      severity: string;
    }[];
    expect(data.map((e) => [e.id, e.severity, e.title])).toEqual([
      ["canonical-elsewhere", "high", "This page tells Google to show a different page"],
      ["host-duplicate", "high", "Your whole site exists at two addresses"],
      ["thin-html", "high", "Google sees an almost empty page"],
      ["noindex", "high", "This page asks search engines not to list it"],
      ["redirect-chain", "medium", "Your address takes several jumps to load"],
      ["canonical-missing", "low", "The page doesn't say which address is the real one"],
    ]);
  });
});

describe("gen-checks: edge cases", () => {
  it("an id in the lock file and missing from the registry: exits 1 and points at STABILITY.md", () => {
    const d = temp();
    writeFileSync(join(d, "lock.json"), JSON.stringify(["canonical-elsewhere", "retired-check"]));
    const r = gen({ GEN_CHECKS_DATA: join(d, "data.json"), GEN_CHECKS_LOCK: join(d, "lock.json") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("retired-check shipped before and is no longer registered");
    expect(r.stderr).toContain("STABILITY.md");
  }, 30_000);

  it("the lock only grows: new ids are added and sorted, none removed", () => {
    expect(updateLock(["b-check"], ["b-check", "a-check"])).toEqual({
      ok: true,
      lock: ["a-check", "b-check"],
    });
    expect(updateLock(["gone"], [])).toEqual({ ok: false, missing: ["gone"] });
  });
});
