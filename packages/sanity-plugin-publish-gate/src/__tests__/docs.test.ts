import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_STATUSES, checkDocument, gateRequestHandler } from "../function.js";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, requestGate } from "../request.js";
import { SITE, barSite, memorySite } from "./helpers.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/publish-gate.md", import.meta.url)),
  "utf8",
);

/** The body of the first fenced block with this title. */
function block(title: string): string {
  const m = new RegExp("```[a-z]* title=" + title + "[^\\n]*\\n([\\s\\S]*?)\\n```").exec(page);
  if (!m) throw new Error(`no block titled ${title}`);
  return m[1] ?? "";
}

describe("docs/publish-gate.md", () => {
  it("the example prints exactly what the page shows, run on an invented copy of the bar's site", async () => {
    const code = block("try-the-gate.ts");
    // The page's example is this call: the test fails if the page stops saying so.
    expect(code).toContain('{ _id: "menu-page", _type: "page", slug: { current: "menu" } }');
    expect(code).toContain(`{ site: "${SITE}", pages: { page: "/{slug}" } }`);
    const transport = memorySite(barSite('<a href="/menu/old-cocktails">Old cocktails</a>'));
    const outcome = await checkDocument(
      { _id: "menu-page", _type: "page", slug: { current: "menu" } },
      { site: SITE, pages: { page: "/{slug}" }, transport },
    );
    const lines = [`${outcome.status} ${"url" in outcome ? outcome.url : ""}`];
    if (outcome.status === "slipped")
      for (const f of outcome.findings) lines.push(`${f.severity.padEnd(4)} ${f.id} ${f.evidence}`);
    expect(lines.join("\n")).toBe(block("Output"));
  });

  it("the request example prints exactly what the page shows, run on an invented copy of the site", async () => {
    const code = block("try-the-request.ts");
    // The page's example is this call: the test fails if the page stops saying so.
    expect(code).toContain('functionUrl: "https://gate.lantern-yard.example/check"');
    expect(code).toContain('pageUrl: "https://lantern-yard.example/menu"');
    expect(code).toContain('allowOrigin: "https://lantern-yard.sanity.studio"');
    const handler = gateRequestHandler({
      site: SITE,
      allowOrigin: "https://lantern-yard.sanity.studio",
      transport: memorySite(barSite('<a href="/menu/old-cocktails">Old cocktails</a>')),
      now: () => new Date("2026-11-12T10:00:00Z"),
    });
    const sent: string[] = [];
    const answer = await requestGate({
      functionUrl: "https://gate.lantern-yard.example/check",
      pageUrl: `${SITE}/menu`,
      fetch: ((url: string, init?: RequestInit) => {
        sent.push(`${init?.method} ${url}`);
        sent.push(
          `credentials=${init?.credentials} redirect=${init?.redirect} referrer=${init?.referrerPolicy}`,
        );
        return handler(
          new Request(String(url), { headers: { origin: "https://lantern-yard.sanity.studio" } }),
        );
      }) as typeof fetch,
    });
    expect(sent.join("\n")).toBe(block("Request"));
    const lines = [`${answer.status} ${answer.url}`];
    for (const f of answer.findings) lines.push(`${f.severity.padEnd(4)} ${f.id} ${f.evidence}`);
    expect(lines.join("\n")).toBe(block("Reply"));
  });

  it("the table of what is sent matches what the request sends", () => {
    for (const claim of [
      "`GET`, with no body",
      "`Accept: application/json`",
      "At most 15 seconds",
      "at most 64 KiB",
      "A redirect is never followed",
      "never as HTML",
    ])
      expect(page, claim).toContain(claim);
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_MAX_BYTES).toBe(64 * 1024);
  });

  it("lists the four statuses the Function can end in, and no other", () => {
    const rows = [...page.matchAll(/^\| `([a-z-]+)`\s+\|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...GATE_STATUSES]);
  });

  it("says it writes nothing and holds no token", () => {
    expect(page).toMatch(/Nothing is written/);
    expect(page).toMatch(/needs no Sanity client and no token/);
  });
});
