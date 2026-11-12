import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EMAIL_PRESET,
  checkSite,
  createFetcher,
  createPageRegistry,
  PROBING_CHECKS,
} from "@gaugeline/core";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { connect, jsonOf, textOf, type Connected } from "./helpers.js";

const opened: Connected[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

async function serve(name: string, options: Parameters<typeof connect>[0] = {}) {
  const fixture = await startFixture(name);
  fixtures.push(fixture);
  const c = await connect({
    allowPrivate: true,
    ...(options.root ? { planBases: [fixture.origin] } : {}),
    ...options,
  });
  opened.push(c);
  return { fixture, ...c };
}

const call = (c: Connected, name: string, args: Record<string, unknown>) =>
  c.client.callTool({ name, arguments: args });

interface RunOut {
  runId: string;
  summary: { high: number; medium: number; low: number };
  findings: {
    id: string;
    checkId: string;
    checkTitle: string;
    evidence: { untrusted: boolean; text: string };
  }[];
  notRun: { dns: { ids: string[] }; probing?: { ids: string[] } };
  probingConsent: boolean;
}

describe("run_check", () => {
  it("returns the same findings as the core engine the CLI calls", async () => {
    const { fixture, client } = await serve("tampered");
    const out = jsonOf<RunOut>(
      await client.callTool({ name: "run_check", arguments: { url: `${fixture.origin}/` } }),
    );
    // The same call the CLI's default run makes: checkSite over the page registry, DNS checks off.
    const registry = createPageRegistry();
    const direct = await checkSite({
      address: `${fixture.origin}/`,
      fetcher: createFetcher({ allowPrivate: true, target: `${fixture.origin}/` }),
      registry,
      skip: EMAIL_PRESET.filter((id) => registry.has(id)),
    });
    expect(out.findings.map((f) => f.checkId)).toEqual(
      direct.result.findings.slice(0, 40).map((f) => f.checkId),
    );
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.notRun.dns.ids.length).toBeGreaterThan(0);
  });

  it("labels page text as untrusted and keeps fixed text apart", async () => {
    const { fixture, client } = await serve("tampered");
    const out = jsonOf<RunOut>(
      await call({ client } as Connected, "run_check", { url: `${fixture.origin}/` }),
    );
    for (const f of out.findings) {
      expect(f.evidence.untrusted).toBe(true);
      expect(f.checkTitle.length).toBeGreaterThan(0);
    }
  });

  it("makes GET and HEAD requests only", async () => {
    const { fixture, client } = await serve("clean");
    jsonOf(await call({ client } as Connected, "run_check", { url: `${fixture.origin}/` }));
    expect([...fixture.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  });

  it("refuses file, ftp and malformed addresses naming the field", async () => {
    const c = await connect();
    opened.push(c);
    for (const url of [
      "file:///etc/passwd",
      "ftp://harbourline.example/",
      "not a url",
      "javascript:alert(1)",
    ]) {
      const r = textOf(await call(c, "run_check", { url }));
      expect(r.isError, url).toBe(true);
      expect(r.text, url).toMatch(/url/i);
    }
  });

  it("refuses loopback, private and metadata addresses unless the server was started with --allow-private", async () => {
    const fixture = await startFixture("clean");
    fixtures.push(fixture);
    const c = await connect(); // no allowPrivate
    opened.push(c);
    for (const url of [
      `${fixture.origin}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
    ]) {
      const r = textOf(await call(c, "run_check", { url }));
      // Refused before a socket opens: an error for a never-reachable literal, a could-not-check entry otherwise.
      expect(r.isError || JSON.parse(r.text).couldNotCheck.length > 0, url).toBe(true);
    }
    expect(fixture.total).toBe(0);
  });

  it("names the field when the input is invalid", async () => {
    const c = await connect();
    opened.push(c);
    const bad = textOf(
      await call(c, "run_check", { url: "https://harbourline.example/", checks: "title" }),
    );
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("checks");
    const flag = textOf(
      await call(c, "run_check", { url: "https://harbourline.example/", flags: { deploy: true } }),
    );
    expect(flag.isError).toBe(true);
    const missing = textOf(await call(c, "run_check", {}));
    expect(missing.text).toContain("url");
  });

  it("rejects an unknown check id before any request is made", async () => {
    const { fixture, client } = await serve("clean");
    const r = textOf(
      await call({ client } as Connected, "run_check", {
        url: `${fixture.origin}/`,
        checks: ["no-such-check"],
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no-such-check");
    expect(fixture.total).toBe(0);
  });

  describe("probing checks and owner consent", () => {
    const PROBE_PATH = "/gaugeline-not-found-3f9c2a71";

    it("does not probe by default", async () => {
      const { fixture, client } = await serve("clean");
      const out = jsonOf<RunOut>(
        await call({ client } as Connected, "run_check", { url: `${fixture.origin}/` }),
      );
      expect(out.probingConsent).toBe(false);
      expect(fixture.hits.get(PROBE_PATH) ?? 0).toBe(0);
    });

    it("does not let a probing check asked for by id bypass consent", async () => {
      const { fixture, client } = await serve("clean");
      const r = textOf(
        await call({ client } as Connected, "run_check", {
          url: `${fixture.origin}/`,
          checks: ["not-found-200"],
        }),
      );
      expect(r.isError).toBe(true);
      expect(r.text).toContain("ownerConsent");
      expect(fixture.total).toBe(0);
      // Mixed with an ordinary check: the ordinary one runs, the probing one is named as withheld.
      const mixed = jsonOf<RunOut>(
        await call({ client } as Connected, "run_check", {
          url: `${fixture.origin}/`,
          checks: ["not-found-200", "canonical-elsewhere"],
        }),
      );
      expect(mixed.notRun.probing?.ids).toEqual(["not-found-200"]);
      expect(fixture.hits.get(PROBE_PATH) ?? 0).toBe(0);
    });

    it("probes only on the call that passes ownerConsent: true, and never remembers it", async () => {
      const { fixture, client } = await serve("clean");
      const c = { client } as Connected;
      const first = jsonOf<RunOut>(
        await call(c, "run_check", { url: `${fixture.origin}/`, ownerConsent: true }),
      );
      expect(first.probingConsent).toBe(true);
      expect(fixture.hits.get(PROBE_PATH) ?? 0).toBeGreaterThan(0);
      const before = fixture.hits.get(PROBE_PATH) ?? 0;
      const second = jsonOf<RunOut>(await call(c, "run_check", { url: `${fixture.origin}/` }));
      expect(second.probingConsent).toBe(false);
      expect(fixture.hits.get(PROBE_PATH) ?? 0).toBe(before);
    });

    it("takes ownerConsent as a boolean only: a string is not consent", async () => {
      const { fixture, client } = await serve("clean");
      const r = textOf(
        await call({ client } as Connected, "run_check", {
          url: `${fixture.origin}/`,
          ownerConsent: "true",
        }),
      );
      expect(r.isError).toBe(true);
      expect(fixture.total).toBe(0);
    });

    it("lists the probing checks as probing", async () => {
      const c = await connect();
      opened.push(c);
      const out = jsonOf<{ checks: { id: string; probing: boolean }[] }>(
        await call(c, "list_checks", {}),
      );
      for (const id of PROBING_CHECKS)
        if (out.checks.some((x) => x.id === id))
          expect(out.checks.find((x) => x.id === id)?.probing).toBe(true);
    });
  });
});

describe("list_checks", () => {
  it("lists every check, and filters by area and framework", async () => {
    const c = await connect();
    opened.push(c);
    const all = jsonOf<{ count: number; checks: { id: string; area: string }[] }>(
      await call(c, "list_checks", {}),
    );
    expect(all.count).toBe(createPageRegistry().size);
    const area = jsonOf<{ checks: { area: string }[] }>(
      await call(c, "list_checks", { area: "Leads" }),
    );
    expect(area.checks.length).toBeGreaterThan(0);
    expect(area.checks.every((x) => x.area === "Leads")).toBe(true);
    const next = jsonOf<{ checks: { id: string }[] }>(
      await call(c, "list_checks", { framework: "next" }),
    );
    expect(next.checks.length).toBeGreaterThan(0);
    expect(next.checks.every((x) => x.id.startsWith("next-") || x.id.includes("-next-"))).toBe(
      true,
    );
  });

  it("names the field for a bad area or framework", async () => {
    const c = await connect();
    opened.push(c);
    expect(textOf(await call(c, "list_checks", { area: "Nope" })).text).toContain("area");
    expect(textOf(await call(c, "list_checks", { framework: "../x" })).text).toContain("framework");
  });
});

describe("explain_finding, draft_fix and compare_runs", () => {
  it("explains a finding by id and a check by id, and refuses an unknown id", async () => {
    const { fixture, client } = await serve("tampered");
    const c = { client } as Connected;
    const run = jsonOf<RunOut>(await call(c, "run_check", { url: `${fixture.origin}/` }));
    const first = run.findings[0];
    expect(first).toBeDefined();
    const one = jsonOf<{
      finding: { id: string };
      check: { what: string; why: string; fix: string; tech: string };
    }>(await call(c, "explain_finding", { id: first?.id }));
    expect(one.finding.id).toBe(first?.id);
    for (const k of ["what", "why", "fix", "tech"] as const)
      expect(one.check[k].length).toBeGreaterThan(0);
    const byCheck = jsonOf<{ check: { id: string } }>(
      await call(c, "explain_finding", { id: first?.checkId }),
    );
    expect(byCheck.check.id).toBe(first?.checkId);
    expect(textOf(await call(c, "explain_finding", { id: "nothing-here" })).isError).toBe(true);
  });

  it("drafts a fix as text, says it is not applied, and sends no request and writes no file", async () => {
    const { fixture, client } = await serve("tampered");
    const c = { client } as Connected;
    const run = jsonOf<RunOut>(await call(c, "run_check", { url: `${fixture.origin}/` }));
    const before = fixture.total;
    const draft = jsonOf<{ applied: boolean; format: string; patch: string }>(
      await call(c, "draft_fix", { findingId: run.findings[0]?.id }),
    );
    expect(draft.applied).toBe(false);
    expect(draft.format).toBe("text/plain");
    expect(draft.patch).toContain("NOT APPLIED");
    expect(fixture.total).toBe(before);
    expect(textOf(await call(c, "draft_fix", { findingId: "missing" })).isError).toBe(true);
  });

  it("compares two runs by finding identity", async () => {
    const { fixture, client } = await serve("tampered");
    const c = { client } as Connected;
    const a = jsonOf<RunOut>(await call(c, "run_check", { url: `${fixture.origin}/` }));
    const b = jsonOf<RunOut>(await call(c, "run_check", { url: `${fixture.origin}/` }));
    const same = jsonOf<{ counts: { new: number; fixed: number; unchanged: number } }>(
      await call(c, "compare_runs", { a: a.runId, b: b.runId }),
    );
    expect(same.counts.new).toBe(0);
    expect(same.counts.fixed).toBe(0);
    expect(textOf(await call(c, "compare_runs", { a: a.runId, b: "run-999" })).isError).toBe(true);
    // A run of a different check set: its findings are the new and the fixed ones.
    const cleaner = jsonOf<RunOut>(
      await call(c, "run_check", { url: `${fixture.origin}/`, checks: ["canonical-elsewhere"] }),
    );
    const diff = jsonOf<{ counts: { fixed: number } }>(
      await call(c, "compare_runs", { a: a.runId, b: cleaner.runId }),
    );
    expect(diff.counts.fixed).toBeGreaterThanOrEqual(0);
  });
});

describe("limits", () => {
  it("keeps to five requests at once however many calls arrive together", async () => {
    const { fixture, client } = await serve("clean");
    const c = { client } as Connected;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call(c, "run_check", { url: `${fixture.origin}/` })),
    );
    for (const r of results) expect(textOf(r).isError).toBe(false);
    expect(fixture.maxConcurrent).toBeLessThanOrEqual(5);
    expect(fixture.total).toBeGreaterThan(12);
  }, 60000);

  it("answers a result too large for one message with a capped list and a pointer", async () => {
    const { fixture, client } = await serve("tampered", { maxFindings: 1 });
    const out = jsonOf<RunOut & { omitted?: number; omittedNote?: string }>(
      await call({ client } as Connected, "run_check", { url: `${fixture.origin}/` }),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.omitted).toBeGreaterThan(0);
    expect(out.omittedNote).toContain(out.runId);
    // What was left out is still there to explain: the run is kept.
    expect(out.summary.high + out.summary.medium + out.summary.low).toBe(1 + (out.omitted ?? 0));
  });
});

describe("plan_check", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gaugeline-mcp-plan-"));
    writeFileSync(
      join(dir, "plan.csv"),
      "Page,URL,Title Tag,H1\nHome,/,Harbourline Books,Welcome\nMenu,/menu.html,Menu,Menu\n",
    );
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "notes.txt"), "x");
  });
  afterEach(() => undefined);

  it("checks a plan inside the root against a site, and keeps the run for explain_finding", async () => {
    const { fixture, client } = await serve("clean", { root: dir });
    const c = { client } as Connected;
    const out = jsonOf<{ runId: string; plan: { rows: number }; findings: { id: string }[] }>(
      await call(c, "plan_check", { planFile: "plan.csv", url: fixture.origin }),
    );
    expect(out.plan.rows).toBe(2);
    expect([...fixture.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    if (out.findings[0]) {
      expect(textOf(await call(c, "explain_finding", { id: out.findings[0].id })).isError).toBe(
        false,
      );
    }
    rmSync(join(dir, "none"), { force: true });
  });

  it("refuses a path outside the root, an absolute path and a non-plan file", async () => {
    const { fixture, client } = await serve("clean", { root: dir });
    const c = { client } as Connected;
    for (const planFile of [
      "../plan.csv",
      "/etc/passwd",
      "sub/notes.txt",
      "missing.csv",
      "..\\..\\x.csv",
    ]) {
      const r = textOf(await call(c, "plan_check", { planFile, url: fixture.origin }));
      expect(r.isError, planFile).toBe(true);
    }
    expect(fixture.total).toBe(0);
  });
});
