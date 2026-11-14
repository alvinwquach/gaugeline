import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * house-rules-broken (HOUSE-01), through the built bin: Wickham Lane Bakery is an invented shop whose page breaks all
 * five rules in its gaugeline.rules.json, and whose clean copy follows them. The check reads the page the run
 * already fetched: the fixture sees GET and HEAD and nothing else.
 */
const sites: Fixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Out = {
  findings: { checkId: string; severity: string; evidence: string; url: string }[];
  couldNotCheck?: unknown;
};
/** Runs the bin against a fixture, in a fresh folder that holds `files`: the fixture's own config files, or text. */
async function run(name: string, config: { copy?: string[]; write?: Record<string, string> }) {
  const site = await startFixture(name);
  sites.push(site);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-house-check-"));
  dirs.push(cwd);
  for (const f of config.copy ?? []) cpSync(join(SITES_DIR, name, f), join(cwd, f));
  for (const [f, text] of Object.entries(config.write ?? {})) writeFileSync(join(cwd, f), text);
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"], {}, { cwd });
  const out = r.status === 0 ? (JSON.parse(r.stdout) as Out) : undefined;
  const ours = (out?.findings ?? []).filter((f) => f.checkId === "house-rules-broken");
  return { r, ours, site, out };
}

describe("house-rules-broken: end to end", () => {
  it("with the fixture's own gaugeline.rules.json, flags each rule the page breaks, with the rule and the element", async () => {
    const { ours } = await run("house-rules-broken", { copy: ["gaugeline.rules.json"] });
    expect(ours.map((f) => [f.severity, f.evidence.split(": ")[0]])).toEqual([
      ["low", "headings.case (headings are in sentence case) on /"],
      ["low", "forbidChars.em-dash (no em dash) on /"],
      ["low", 'forbidTerms.cheap (never use "cheap") on /'],
      ["low", 'forbidTerms.bargain (never use "bargain") on /'],
      ["low", 'buttonLabel (buttons say "Book now") on /'],
      ["low", "phoneFormat (phone numbers look like ### ### ####) on /"],
    ]);
    expect(ours[0]?.evidence).toContain('h2 heading "Our Fresh Cakes And Pastries"');
    expect(ours[4]?.evidence).toContain('button "Book Now!"');
    expect(ours[5]?.evidence).toContain('page text "###.###.####"');
    for (const f of ours) expect(f.evidence.length).toBeLessThan(220);
  });

  it("finds nothing on the clean copy, and nothing is left as could not check", async () => {
    const { ours, out } = await run("house-rules-clean", { copy: ["gaugeline.rules.json"] });
    expect(ours).toEqual([]);
    expect(out).toBeDefined();
    expect(JSON.stringify(out?.couldNotCheck)).not.toContain("house-rules-broken");
  });

  it("with no gaugeline.rules.json, asks nothing and finds nothing", async () => {
    const { ours, out } = await run("house-rules-broken", {});
    expect(ours).toEqual([]);
    expect(out).toBeDefined();
  });

  it("a draft file is never read: only gaugeline.rules.json counts", async () => {
    const rules = JSON.stringify({ version: 1, forbidTerms: ["cheap"] });
    const { ours } = await run("house-rules-broken", {
      write: { "gaugeline.rules.draft.json": rules },
    });
    expect(ours).toEqual([]);
  });

  it("only one rule in the file means only that rule is read", async () => {
    const { ours } = await run("house-rules-broken", {
      write: { "gaugeline.rules.json": JSON.stringify({ version: 1, forbidTerms: ["bargain"] }) },
    });
    expect(ours.map((f) => f.evidence.split(" ")[0])).toEqual(["forbidTerms.bargain"]);
  });

  it("makes no request but GET and HEAD, and none for the rules", async () => {
    const { site } = await run("house-rules-broken", { copy: ["gaugeline.rules.json"] });
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.some((q) => q.path.includes("rules"))).toBe(false);
  });

  it("gives the same findings on a second run", async () => {
    const a = await run("house-rules-broken", { copy: ["gaugeline.rules.json"] });
    const b = await run("house-rules-broken", { copy: ["gaugeline.rules.json"] });
    expect(a.ours.map((f) => f.evidence)).toEqual(b.ours.map((f) => f.evidence));
  });
});

describe("gaugeline.rules.json that is wrong is refused, naming the file (exit 2)", () => {
  const cases: [string, string, string][] = [
    [
      "a pattern in a word",
      JSON.stringify({ version: 1, forbidTerms: ["(a+)+$"] }),
      "forbidTerms.0",
    ],
    ["a key it does not have", JSON.stringify({ version: 1, pattern: "a+" }), "pattern"],
    [
      "a path as a label",
      JSON.stringify({ version: 1, buttonLabel: "/etc/passwd" }),
      "buttonLabel",
    ],
    ["not JSON", "{ nope", "not valid JSON"],
    ["a wrong version", JSON.stringify({ version: 2 }), "version"],
  ];
  for (const [what, text, expected] of cases)
    it(what, async () => {
      const { r } = await run("house-rules-broken", { write: { "gaugeline.rules.json": text } });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("gaugeline.rules.json");
      expect(r.stderr).toContain(expected);
    });

  it("a file over the size limit is refused before it is parsed", async () => {
    const big = JSON.stringify({ version: 1, forbidTerms: ["cheap"], pad: "x".repeat(70_000) });
    const { r } = await run("house-rules-broken", { write: { "gaugeline.rules.json": big } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("larger than");
  });
});
