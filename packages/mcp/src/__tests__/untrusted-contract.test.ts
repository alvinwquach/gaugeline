/**
 * AG-01: one contract for page text in every tool result. Text taken from a site is delivered only in
 * a labelled untrusted slot ({ untrusted: true, source, text, truncated, strippedDirectives }), cleaned
 * and capped; every sentence the server writes itself (summaries, hints, errors, descriptions, _meta)
 * is fixed text. A test walks each tool's output for a hostile page and finds every canary the page
 * planted: all of them must be inside a declared slot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNTRUSTED_CAPS } from "@gaugeline/core";
import { TOOLS } from "../registry.js";
import { CANARIES, CANARY, INJECTION, startHostileSite } from "./hostile-site.js";
import type { HostileSite } from "./hostile-site.js";
import { connect, jsonOf, textOf, type Connected } from "./helpers.js";
import { findLeaks, walkSlots } from "./untrusted-walk.js";

type ToolName = keyof typeof TOOLS;

let site: HostileSite;
let c: Connected;

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
  c = await connect({ allowPrivate: true });
});

afterAll(async () => {
  await c.close();
  await site.close();
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

  it("keeps the canaries distinct and ASCII, so a leak says where it came from", () => {
    expect(new Set(CANARIES).size).toBe(CANARIES.length);
    for (const k of CANARIES) expect(k).toMatch(/^ZQX[A-Z]+$/);
  });
});
