import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where a request that writes can be built. Gaugeline reads: a POST, PUT, PATCH or DELETE is built
 * in exactly these files, and a new one is a reviewed decision, not a line in a feature branch.
 *
 * - `core/src/notify/post.ts`: notifications to the person's own channels (ADR-0005).
 * - `core/src/fetcher.ts`: `fetcher.query()`, a POST to a documented read-only query endpoint on an
 *   adapter's allowlist, with a body checked to be a query (ADR-0006, the owner's decision of
 *   11 Nov 2026). It is the second and last place a request to a vendor's API is POSTed.
 * - `app/src/api.ts`: the app's page talking to its own local server (never a checked site).
 *
 * This list is a safeguard. Do not add a file to make a branch pass.
 */
const ALLOWED: readonly string[] = [
  "core/src/notify/post.ts",
  "core/src/fetcher.ts",
  "app/src/api.ts",
];

/** A `method` property or variable given one of the verbs that change something. */
const WRITE_METHOD = /\bmethod["']?\s*[:=]\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i;
/** The same, written as a call: request("POST", ...), .request({ method }) is covered above. */
const WRITE_CALL = /\b(?:request|fetch|send|open)\s*\(\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i;
/** A tagged method header that turns one request into another. */
const OVERRIDE = /x-http-method(?:-override)?|x-method-override/i;

const packagesDir = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (["__tests__", "node_modules", "dist"].includes(n)) return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.tsx?$/.test(n) ? [full] : [];
  });
}

function allSources(): { file: string; text: string }[] {
  return readdirSync(packagesDir).flatMap((pkg) => {
    const src = join(packagesDir, pkg, "src");
    try {
      if (!statSync(src).isDirectory()) return [];
    } catch {
      return [];
    }
    return sources(src).map((full) => ({
      file: relative(packagesDir, full).split(sep).join("/"),
      text: readFileSync(full, "utf8"),
    }));
  });
}

/** The files that build a write request, by the rules above. Exported for the self-test. */
export function writers(files: readonly { file: string; text: string }[]): string[] {
  return files
    .filter((f) => WRITE_METHOD.test(f.text) || WRITE_CALL.test(f.text) || OVERRIDE.test(f.text))
    .map((f) => f.file)
    .sort();
}

describe("ADR-0005 and ADR-0006: where a POST, PUT, PATCH or DELETE can be built", () => {
  it("only the notification sender, the fetcher's query() and the app's own page build one", () => {
    const found = writers(allSources()).filter((f) => !ALLOWED.includes(f));
    expect(found).toEqual([]);
  });

  it("the allowed files still build one (a stale entry is removed, not kept)", () => {
    const found = writers(allSources());
    for (const file of ALLOWED) expect(found, file).toContain(file);
  });

  it("the fetcher builds a POST in one place only, and never PUT, PATCH or DELETE", () => {
    const text = readFileSync(join(packagesDir, "core/src/fetcher.ts"), "utf8");
    const verbs = [...text.matchAll(/["'`](POST|PUT|PATCH|DELETE)["'`]/g)].map((m) => m[1]);
    expect(verbs.filter((v) => v !== "POST")).toEqual([]);
    // The type, the refusal text and the one call to requestOnce; no other literal builds a POST.
    expect(text.match(/requestOnce\(\s*target\.href,\s*"POST"/g)).toHaveLength(1);
  });

  it("the transport can send GET, HEAD and POST and no other method", () => {
    const text = readFileSync(join(packagesDir, "core/src/transport.ts"), "utf8");
    expect(text).toMatch(/method: "GET" \| "HEAD" \| "POST";/);
    expect(text).not.toMatch(/"(PUT|PATCH|DELETE)"/);
  });

  it("the scan itself catches each way of building a write", () => {
    const hit = (text: string) => writers([{ file: "x.ts", text }]);
    expect(hit('fetch(u, { method: "POST" })')).toEqual(["x.ts"]);
    expect(hit("fetch(u, { method: 'delete' })")).toEqual(["x.ts"]);
    expect(hit('const method = "PATCH";')).toEqual(["x.ts"]);
    expect(hit('client.request("PUT", u)')).toEqual(["x.ts"]);
    expect(hit('headers["X-HTTP-Method-Override"] = "DELETE"')).toEqual(["x.ts"]);
    expect(hit('fetch(u, { method: "GET" })')).toEqual([]);
    expect(hit('if (req.method !== "POST") return;')).toEqual([]);
    expect(hit("runs.delete(id); map.set(a, b);")).toEqual([]);
  });
});
