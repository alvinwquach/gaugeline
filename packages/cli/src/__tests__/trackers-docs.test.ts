import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transport } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { answer, bookingPage, containerHost } from "../../../core/src/trackers/__tests__/world.js";
import { EXIT, main } from "../main.js";

/**
 * docs/guides/trackers-on-sensitive-pages.md shows `npx gaugeline ... --trackers` twice. The first runs against
 * the clinic-trackers fixture in `pnpm docs:examples`. The second reads a Tag Manager container as well, so this
 * test runs it against recorded responses (core's trackers/__tests__/world.ts) and compares the Output block
 * with what the CLI prints. The "passed" lines (a tick and a check id) are left out of the block, as the docs
 * runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/trackers-on-sensitive-pages.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

function untestedExample(): { command: string; expected: string } {
  const all = fences();
  const at = all.findIndex((f) => /untested=/.test(f.info));
  const next = all[at + 1];
  if (at < 0 || !next || !/title="?Output/.test(next.info)) throw new Error("no untested example");
  return { command: (all[at]?.body ?? "").replace(/^\$ npx gaugeline /, ""), expected: next.body };
}

describe("docs/guides/trackers-on-sensitive-pages.md: the commands it shows", () => {
  it("has the clinic example the docs runner runs, and the coach example this test runs", () => {
    expect(page).toContain("<!-- fixture: clinic-trackers -->");
    expect(untestedExample().command).toBe("tideline-coaching.example/book --trackers");
  });

  it("the settings it shows are settings the CLI accepts", async () => {
    const shown = fences().find((f) => /title=gaugeline\.trackers\.json/.test(f.info));
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-trackers-docs-")));
    dirs.push(dir);
    writeFileSync(join(dir, "gaugeline.trackers.json"), shown?.body ?? "");
    const code = await main(
      ["tideline-coaching.example/book", "--trackers", "--json", "--no-open", "--quiet"],
      { stdout: { write: () => undefined }, stderr: { write: () => undefined }, env: {} },
      { cwd: dir, fetcher: { transport: world() } } as never,
    );
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(shown?.body ?? "")).toEqual({
      sensitivePaths: ["/intake", "/book", "/conditions/*"],
    });
  });

  it("prints what the page says for the coach", async () => {
    const e = untestedExample();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-trackers-docs-")));
    dirs.push(dir);
    const out: string[] = [];
    const code = await main(
      [...e.command.split(/\s+/), "--no-open", "--quiet"],
      {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => undefined },
        env: { NO_COLOR: "1" },
      },
      { cwd: dir, fetcher: { transport: world() } } as never,
    );
    expect(code).toBe(EXIT.ok);
    const shown = out
      .join("")
      .split("\n")
      .filter((l) => !/^✓ [a-z0-9-]+$/.test(l))
      .join("\n");
    expect(shown.trimEnd()).toBe(e.expected);
  });

  it("the page names the checks, the settings file, the flag and the client's own counsel", () => {
    for (const word of [
      "tracker-on-sensitive-page",
      "tracker-in-tag-manager",
      "gaugeline.trackers.json",
      "sensitivePaths",
      "--trackers",
      "run --all --trackers",
      "own counsel",
    ])
      expect(page, word).toContain(word);
    expect(page).not.toMatch(/illegal|unlawful|violat|HIPAA|GDPR/i);
  });
});

/** The coach's site: /book, and the files every site has, answered in memory; the container is at Google's host. */
function world(): Transport {
  const others = containerHost();
  const files: Record<string, [string, string]> = {
    "/book": ["text/html; charset=utf-8", bookingPage("Book a call | Tideline Coaching")],
    "/robots.txt": [
      "text/plain",
      "User-agent: *\nAllow: /\nSitemap: https://tideline-coaching.example/sitemap.xml\n",
    ],
    "/sitemap.xml": [
      "application/xml",
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://tideline-coaching.example/book</loc></url></urlset>',
    ],
    "/og.png": ["image/png", "png"],
  };
  return (url, req) => {
    if (url.hostname !== "tideline-coaching.example") return others(url, req);
    const file = files[url.pathname];
    return file
      ? answer(200, file[0], file[1], req.method)
      : answer(404, "text/plain", "not found", req.method);
  };
}
