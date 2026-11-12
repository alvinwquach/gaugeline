import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No tool can write, publish, merge or change a site. The repository-wide scan
 * (packages/core/src/__tests__/post-boundary.test.ts) already covers every package's source for a
 * request that changes something; this one adds what only this package needs: it has no way to write
 * a file, open an outgoing connection of its own, run a program or send any method but the fetcher's.
 */
const src = fileURLToPath(new URL("../", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (n === "__tests__") return [];
    return statSync(full).isDirectory() ? files(full) : n.endsWith(".ts") ? [full] : [];
  });
}
const sources = files(src).map((f) => ({
  file: relative(src, f).split(sep).join("/"),
  text: readFileSync(f, "utf8"),
}));
const where = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.file);

describe("packages/mcp has no write, publish or request code path of its own", () => {
  it("never calls a file-writing function", () => {
    expect(
      where(
        /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|symlink|chmod|utimes|open|openSync)\s*\(/,
      ),
    ).toEqual([]);
  });

  it("reads files only in plan_check, and only through the checked reader", () => {
    expect(where(/from "node:fs(\/promises)?"/)).toEqual(["tools/plan-check.ts"]);
    const text = sources.find((s) => s.file === "tools/plan-check.ts")?.text ?? "";
    expect(text).toMatch(/import \{ readFileSync, realpathSync, statSync \} from "node:fs"/);
  });

  it("opens no outgoing connection and runs no program", () => {
    expect(where(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|new Request\b/)).toEqual([]);
    expect(
      where(/node:https|node:net|node:tls|node:dgram|node:child_process|node:worker_threads/),
    ).toEqual([]);
    expect(where(/\bhttp\.request|\bhttp\.get|\brequest\s*\(/)).toEqual([]);
    expect(where(/(?<![.\w])(spawn|exec|execFile|execSync|execFileSync)\s*\(/)).toEqual([]);
  });

  it("uses node:http only to listen, in the HTTP transport", () => {
    expect(where(/from "node:http"/)).toEqual(["http.ts"]);
    const text = sources.find((s) => s.file === "http.ts")?.text ?? "";
    expect(text).toMatch(
      /import \{ createServer, type IncomingMessage, type Server, type ServerResponse \} from "node:http"/,
    );
  });

  it("names no method that changes anything, and POST only where the server checks an inbound request", () => {
    expect(where(/["'`](PUT|PATCH|DELETE)["'`]/i)).toEqual([]);
    expect(where(/["'`]POST["'`]/)).toEqual(["http.ts"]);
    expect(where(/\.query\s*\(|registerQueryAllow/)).toEqual([]);
  });

  it("reaches a site only through the core fetcher, and registers tools only from the registry", () => {
    expect(where(/\bcreateFetcher\s*\(/)).toEqual(["state.ts"]);
    expect(where(/\.registerTool\s*\(/)).toEqual(["server.ts"]);
    expect(where(/\bnotify|sendNotification|postNotification/i)).toEqual([]);
  });
});
