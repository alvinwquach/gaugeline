import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { CheckRegistry, defineCheck, type Finding, type Severity } from "../../model.js";
import { runChecks } from "../../run.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { html, startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { PAGE_CHECKS, createPageRegistry } from "../index.js";
import { page } from "./helpers.js";

const base = { area: "Visitors", what: "w", why: "y", fix: "f" } as const;
function fixed(id: string, severity: Severity): ReturnType<typeof defineCheck<PageSnapshot>> {
  return defineCheck<PageSnapshot>({
    ...base,
    id,
    severity,
    title: id,
    run: (p): Finding[] => [{ checkId: id, severity, title: id, evidence: "e", url: p.finalUrl }],
  });
}

describe("runner: unit", () => {
  it("sort order: high before medium before low, then registration order", async () => {
    const r = new CheckRegistry();
    for (const c of [
      fixed("low-a", "low"),
      fixed("med-a", "medium"),
      fixed("high-a", "high"),
      fixed("low-b", "low"),
      fixed("high-b", "high"),
    ]) {
      r.register(c);
    }
    const out = await runChecks(page(), r);
    expect(out.findings.map((f) => f.checkId)).toEqual([
      "high-a",
      "high-b",
      "med-a",
      "low-a",
      "low-b",
    ]);
  });

  it("only and skip select checks; an unknown id is a config error", async () => {
    const r = createPageRegistry();
    const only = await runChecks(page({ canonicals: [] }), r, { only: ["canonical-missing"] });
    expect([...only.passed, ...only.findings.map((f) => f.checkId)]).toEqual(["canonical-missing"]);
    const skipped = await runChecks(page(), r, { skip: ["host-duplicate"] });
    expect(skipped.passed).not.toContain("host-duplicate");
    await expect(runChecks(page(), r, { only: ["nope"] })).rejects.toBeInstanceOf(ConfigError);
  });

  it("registers the six checks in the documented order", () => {
    expect(PAGE_CHECKS.map((c) => c.id)).toEqual([
      "canonical-elsewhere",
      "host-duplicate",
      "thin-html",
      "noindex",
      "redirect-chain",
      "canonical-missing",
    ]);
    for (const c of PAGE_CHECKS) expect(c.what && c.why && c.fix && c.tech).toBeTruthy();
  });
});

describe("runner: edge cases", () => {
  it("one check throws, the other five still report", async () => {
    const r = new CheckRegistry();
    r.register(
      defineCheck<PageSnapshot>({
        ...base,
        id: "explodes",
        severity: "high",
        title: "x",
        run: () => {
          throw new Error("boom");
        },
      }),
    );
    for (const c of PAGE_CHECKS.filter((c) => c.id !== "host-duplicate")) r.register(c);
    const thin = page({ canonicals: [], contentWordCount: 3, metaRobots: "noindex" });
    const out = await runChecks(thin, r);
    expect(out.failed).toEqual([{ id: "explodes", error: "boom" }]);
    expect(out.findings.map((f) => f.checkId).sort()).toEqual([
      "canonical-missing",
      "noindex",
      "thin-html",
    ]);
    expect(out.passed.sort()).toEqual(["canonical-elsewhere", "redirect-chain"]);
  });
});

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("runner: integration", () => {
  it('fixture site "duplicate-host" produces exactly host-duplicate and nothing else', async () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const body = `<html><head><title>Fixture Bakery</title><link rel="canonical" href="http://duplicate.test/"></head><body><main><h1>Fixture Bakery</h1><p>${words}</p></main></body></html>`;
    const bare = await startServer({ "/": html(body) });
    const www = await startServer({ "/": html(body) });
    servers.push(bare, www);
    const fetcher = createFetcher({
      allowPrivate: true,
      hosts: {
        "duplicate.test": `127.0.0.1:${bare.port}`,
        "www.duplicate.test": `127.0.0.1:${www.port}`,
      },
    });
    const snapshot = buildSnapshot(await fetcher.getSite("duplicate.test"));
    expect(snapshot.finalUrl).toBe("http://duplicate.test/");
    const out = await runChecks(snapshot, createPageRegistry(), { ctx: { fetcher } });
    expect(out.failed).toEqual([]);
    expect(out.findings.map((f) => f.checkId)).toEqual(["host-duplicate"]);
    expect([...bare.log, ...www.log].every((r) => r.method === "GET")).toBe(true);
  });
});
