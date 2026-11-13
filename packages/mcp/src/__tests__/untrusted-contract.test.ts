/**
 * AG-01: one contract for page text in every tool result. Text taken from a site is delivered only in
 * a labelled untrusted slot ({ untrusted: true, source, text, truncated, strippedDirectives }), cleaned
 * and capped; every sentence the server writes itself (summaries, hints, errors, descriptions, _meta)
 * is fixed text. A test walks each tool's output for a hostile page and finds every canary the page
 * planted: all of them must be inside a declared slot.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNTRUSTED_CAPS } from "@gaugeline/core";
import { TOOLS } from "../registry.js";
import { CANARIES, CANARY, HIDDEN, INJECTION, TAGGED, startHostileSite } from "./hostile-site.js";
import type { HostileSite } from "./hostile-site.js";
import { connect, jsonOf, textOf, type Connected } from "./helpers.js";
import { findLeaks, walkSlots } from "./untrusted-walk.js";

type ToolName = keyof typeof TOOLS;

let site: HostileSite;
let root: string;
let c: Connected;
/** Every slot path each tool delivered, across all the calls below. */
const seen = new Map<string, Set<string>>();

const call = (name: ToolName, args: Record<string, unknown>) =>
  c.client.callTool({ name, arguments: args });

/** Code point ranges the cleaner removes or shows as escapes: none may appear raw on the wire. */
const FORBIDDEN: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];
const hasForbidden = (text: string) =>
  [...text].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return FORBIDDEN.some(([lo, hi]) => cp >= lo && cp <= hi);
  });

/** The whole contract for one successful result. */
function expectContract(tool: ToolName, result: unknown) {
  const { text, isError } = textOf(result);
  expect(isError, text.slice(0, 200)).toBe(false);
  const { slots, outside } = walkSlots(JSON.parse(text));
  const declared = new Set(TOOLS[tool].untrustedSlots ?? []);
  for (const slot of slots) {
    expect(declared.has(slot.path), `${tool}: ${slot.path} is not a declared slot`).toBe(true);
    seen.set(tool, (seen.get(tool) ?? new Set()).add(slot.path));
    expect(Object.keys(slot.field).sort()).toEqual([
      "source",
      "strippedDirectives",
      "text",
      "truncated",
      "untrusted",
    ]);
    expect(slot.field.source.length).toBeGreaterThan(0);
    expect(findLeaks(slot.field.source)).toEqual([]);
    // A diff is capped by construction (six quoted lines); every other slot by the cleaner, in characters.
    const size =
      slot.path === "patch"
        ? slot.field.text.length
        : [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(slot.field.text)]
            .length;
    const cap = slot.path === "patch" ? 2000 : UNTRUSTED_CAPS.evidence;
    expect(size, `${tool}: ${slot.path} over its cap`).toBeLessThanOrEqual(cap);
    if (slot.field.truncated) expect(slot.field.text).toMatch(/\[cut\]$/);
  }
  // (d) nothing the page wrote is in text the server wrote.
  expect(findLeaks(outside), `${tool}: page text outside a slot`).toEqual([]);
  // (c) the wire text has no hidden, bidi or control character left.
  expect(hasForbidden(text), `${tool}: a hidden character reached the wire`).toBe(false);
  // (b) a bounded result, whatever the page sent (the page below is over 200 KB).
  expect(text.length, `${tool}: result size`).toBeLessThan(120_000);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  site = await startHostileSite();
  root = mkdtempSync(join(tmpdir(), "gaugeline-ag01-"));
  mkdirSync(join(root, "plans"));
  const cell = `${CANARY.plan} ${INJECTION}${HIDDEN}${TAGGED}`;
  writeFileSync(
    join(root, "hostile.csv"),
    [
      "Page,URL,Title Tag,H1,Legacy URL",
      `"${cell}",/a,"${cell}",One,/${CANARY.legacy}-a`,
      `Two,/b,"${cell}",Two,/${CANARY.legacy}-b`,
      `Three,//evil.example/${CANARY.offBase},Three,Three,`,
    ].join("\n"),
  );
  // 400 rows that share one title tag: one finding that covers every line.
  const many = ["Page,URL,Title Tag,H1"];
  for (let i = 0; i < 400; i++) many.push(`P${i},/p${i},Same title,Same title`);
  writeFileSync(join(root, "many.csv"), many.join("\n"));
  c = await connect({ allowPrivate: true, root, planBases: [site.origin] });
});

afterAll(async () => {
  await c.close();
  await site.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("the walker finds a leak (the naive result)", () => {
  it("leak case: rejects a result that writes page text into a sentence of its own", () => {
    const naive = {
      summary: `The page says: ${CANARY.title} ${INJECTION}`,
      findings: [{ title: { untrusted: true, source: "s", text: CANARY.title } }],
    };
    expect(findLeaks(walkSlots(naive).outside)).toEqual([CANARY.title]);
  });
  it("clean case: accepts a result that carries the same text only inside its slot", () => {
    const labelled = {
      summary: "One finding.",
      findings: [{ title: { untrusted: true, source: "s", text: `${CANARY.title} x` } }],
    };
    expect(findLeaks(walkSlots(labelled).outside)).toEqual([]);
    expect(walkSlots(labelled).slots.map((s) => s.path)).toEqual(["findings[].title"]);
  });
});

describe("run_check", () => {
  it("clean case: a hostile page (injection text, hidden characters, tag characters, a 200 KB description) comes back labelled, cleaned and capped", async () => {
    const out = expectContract("run_check", await call("run_check", { url: `${site.origin}/` }));
    const text = JSON.stringify(out);
    // The page's words are there to be reported, inside the slots.
    expect(text).toContain(CANARY.canonical);
    // A hidden character that is not between two letters is shown as an escape, not carried raw.
    expect(text).toContain("\\\\u{2062}");
  });

  it("clean case: one 100,000-point cluster in an address is cut, not carried whole", async () => {
    const out = jsonOf<{
      findings: { checkId: string; evidence: { text: string; truncated: boolean } }[];
    }>(await call("run_check", { url: `${site.origin}/`, checks: ["canonical-elsewhere"] }));
    const f = out.findings.find((x) => x.checkId === "canonical-elsewhere");
    expect(f).toBeDefined();
    expect(f?.evidence.truncated).toBe(true);
    expect(f?.evidence.text.length).toBeLessThan(2000);
  });

  it("clean case: an ordinary page with text in other scripts reads fine, unchanged and not cut", async () => {
    const out = expectContract(
      "run_check",
      await call("run_check", { url: `${site.origin}/ordinary`, checks: ["broken-links"] }),
    ) as {
      findings: { evidence: { text: string; truncated: boolean; strippedDirectives: number } }[];
    };
    const e = out.findings[0]?.evidence;
    expect(e?.text).toContain("Caf\u00E9 \u30E1\u30CB\u30E5\u30FC \u{1F600}");
    expect(e?.truncated).toBe(false);
    expect(e?.strippedDirectives).toBe(0);
  });

  it("clean case: an unreachable page gives a labelled reason with no address a name resolved to", async () => {
    const out = expectContract("run_check", await call("run_check", { url: `${site.origin}/hop` }));
    expect(JSON.stringify(out)).not.toContain("169.254");
  });

  it("leak case: an unknown check id that is page text is not echoed", async () => {
    const r = textOf(
      await call("run_check", { url: `${site.origin}/`, checks: [`${CANARY.title} ${INJECTION}`] }),
    );
    expect(r.isError).toBe(true);
    expect(findLeaks(r.text)).toEqual([]);
    expect(r.text).not.toContain("attacker.example");
  });
});

describe("explain_finding", () => {
  it("clean case: a finding from the hostile page is explained with page text only in its slots", async () => {
    const run = jsonOf<{ findings: { id: string }[] }>(
      await call("run_check", { url: `${site.origin}/`, checks: ["canonical-elsewhere"] }),
    );
    const id = run.findings[0]?.id ?? "";
    expect(id).not.toBe("");
    const out = expectContract("explain_finding", await call("explain_finding", { id })) as {
      check?: { title: string };
    };
    expect(out.check?.title).toBeTruthy();
  });

  it("leak case: an id that is page text is not echoed in the error", async () => {
    const r = textOf(await call("explain_finding", { id: `${CANARY.title} ${INJECTION}` }));
    expect(r.isError).toBe(true);
    expect(findLeaks(r.text)).toEqual([]);
    expect(r.text).not.toContain("attacker.example");
  });

  it("clean case: a plan finding's group key is delivered in its slot", async () => {
    const plan = jsonOf<{ findings: { id: string; group?: unknown }[] }>(
      await call("plan_check", { planFile: "hostile.csv", url: site.origin }),
    );
    const grouped = plan.findings.find((f) => f.group);
    expect(grouped).toBeDefined();
    expectContract("explain_finding", await call("explain_finding", { id: grouped?.id ?? "" }));
  });
});

describe("compare_runs", () => {
  it("clean case: new and fixed findings from the hostile page carry page text only in their slots", async () => {
    const a = jsonOf<{ runId: string }>(
      await call("run_check", { url: `${site.origin}/`, checks: ["viewport"] }),
    );
    const b = jsonOf<{ runId: string }>(
      await call("run_check", { url: `${site.origin}/`, checks: ["canonical-elsewhere"] }),
    );
    const out = expectContract(
      "compare_runs",
      await call("compare_runs", { a: a.runId, b: b.runId }),
    ) as {
      counts: { new: number; fixed: number };
    };
    expect(out.counts.new).toBeGreaterThan(0);
    expect(out.counts.fixed).toBeGreaterThan(0);
  });

  it("leak case: a run id that is page text is not echoed in the error", async () => {
    const r = textOf(
      await call("compare_runs", { a: `${CANARY.title}${INJECTION}`.slice(0, 40), b: "run-1" }),
    );
    expect(r.isError).toBe(true);
    expect(findLeaks(r.text)).toEqual([]);
  });
});

/** A plan run, for the tools that read a plan finding. */
async function planRun(planFile: string) {
  return jsonOf<{ runId: string; findings: { id: string; group?: unknown }[] }>(
    await call("plan_check", { planFile, url: site.origin }),
  );
}

describe("plan findings through the other tools", () => {
  it("clean case: compare_runs delivers a plan finding's group key only in its slot", async () => {
    const a = await planRun("hostile.csv");
    const b = await planRun("many.csv");
    expectContract("compare_runs", await call("compare_runs", { a: a.runId, b: b.runId }));
  });

  it("clean case: draft_fix gives a plan finding in words, with its group key only in the slot", async () => {
    const plan = await planRun("hostile.csv");
    const id = plan.findings.find((f) => f.group)?.id ?? "";
    const out = expectContract("draft_fix", await call("draft_fix", { findingId: id })) as {
      patchKind: string;
    };
    expect(out.patchKind).toBe("words");
  });
});

describe("plan_check", () => {
  it("clean case: hostile plan cells (injection text, hidden characters) come back only in slots", async () => {
    const out = expectContract(
      "plan_check",
      await call("plan_check", { planFile: "hostile.csv", url: site.origin }),
    ) as { couldNotCheck: { reason: { untrusted: boolean } }[] };
    // The row that points off the preview is reported by line number and a fixed sentence.
    expect(out.couldNotCheck.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("evil.example");
  });

  it("leak case: one finding that covers 400 rows lists a bounded number of lines", async () => {
    const out = jsonOf<{
      findings: { group?: { lines: number[]; linesTotal?: number } }[];
    }>(await call("plan_check", { planFile: "many.csv", url: site.origin }));
    const g = out.findings.map((f) => f.group).find((x) => x?.linesTotal !== undefined);
    expect(g).toBeDefined();
    expect(g?.lines.length).toBeLessThanOrEqual(50);
    expect(g?.linesTotal).toBe(400);
  });
});

describe("draft_fix", () => {
  const draftFor = async (path: string, checks: string[]) => {
    const run = jsonOf<{ findings: { id: string; checkId: string }[] }>(
      await call("run_check", { url: `${site.origin}${path}`, checks }),
    );
    const id = run.findings.find((f) => f.checkId === checks[0])?.id ?? "";
    expect(id, `a ${checks[0]} finding for ${path}`).not.toBe("");
    return call("draft_fix", { findingId: id });
  };

  it("clean case: a plain page gets a diff, page lines only inside the labelled diff, nothing applied", async () => {
    const out = expectContract("draft_fix", await draftFor("/plain", ["viewport"])) as {
      patchKind: string;
      patch: { text: string };
      applied: boolean;
    };
    expect(out.applied).toBe(false);
    expect(out.patchKind).toBe("unified-diff");
    expect(out.patch.text).toContain('+  <meta name="viewport"');
  });

  it("leak case: a page line holding ``` is not quoted into the diff, so it cannot close a code fence", async () => {
    const out = expectContract("draft_fix", await draftFor("/fence", ["viewport"])) as {
      patchKind: string;
      patch: unknown;
    };
    expect(JSON.stringify(out.patch)).not.toContain("```");
    expect(out.patchKind).toBe("words");
  });

  it("clean case: a page whose lines hold hidden characters gets the change in words, not a diff", async () => {
    const out = expectContract("draft_fix", await draftFor("/", ["viewport"])) as {
      patchKind: string;
    };
    expect(out.patchKind).toBe("words");
  });
});

describe("list_checks", () => {
  it("clean case: carries no page text and no slot", async () => {
    const out = expectContract("list_checks", await call("list_checks", {}));
    expect(walkSlots(out).slots).toEqual([]);
    expect(TOOLS.list_checks.untrustedSlots ?? []).toEqual([]);
  });
});

describe("the whole surface", () => {
  it("clean case: tool names, descriptions and _meta are fixed text, with the slots listed", async () => {
    const { tools } = await c.client.listTools();
    const wire = JSON.stringify(tools);
    expect(findLeaks(wire)).toEqual([]);
    for (const t of tools) {
      const def = TOOLS[t.name as ToolName];
      expect(t._meta?.["gaugeline/untrustedSlots"] ?? [], t.name).toEqual(def.untrustedSlots ?? []);
    }
  });

  it("clean case: every declared slot was delivered by some call above, so no declaration is stale", () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      for (const slot of def.untrustedSlots ?? [])
        expect(seen.get(name)?.has(slot), `${name} never delivered ${slot}`).toBe(true);
    }
  });

  it("keeps the canaries distinct and ASCII, so a leak says where it came from", () => {
    expect(new Set(CANARIES).size).toBe(CANARIES.length);
    for (const k of CANARIES) expect(k).toMatch(/^ZQX[A-Z]+$/);
  });
});
