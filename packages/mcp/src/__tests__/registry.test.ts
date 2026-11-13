import { describe, expect, it } from "vitest";
import { TOOLS, assertLabelled, assertUntrustedSlots, describeTool } from "../registry.js";
import { UNTRUSTED_NOTE } from "../agent-text.js";
import { connect } from "./helpers.js";

describe("the tool registry", () => {
  it("has exactly the six tools, in one object", () => {
    expect(Object.keys(TOOLS).sort()).toEqual([
      "compare_runs",
      "draft_fix",
      "explain_finding",
      "list_checks",
      "plan_check",
      "run_check",
    ]);
  });

  it("gives every tool a kind of read or draft, and only draft_fix is a draft", () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      expect(["read", "draft"], name).toContain(def.kind);
    }
    const drafts = Object.entries(TOOLS)
      .filter(([, d]) => d.kind === "draft")
      .map(([n]) => n);
    expect(drafts).toEqual(["draft_fix"]);
  });

  it("shows the kind in every description, and says plainly that nothing is changed", () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      const text = describeTool(def);
      expect(text.startsWith(`[${def.kind}] `), name).toBe(true);
      expect(text, name).toMatch(/changes nothing|applies, writes, commits and publishes nothing/);
    }
  });

  it("repeats the untrusted-text note in every tool that returns page text", () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      expect(describeTool(def).includes(UNTRUSTED_NOTE), name).toBe(def.pageText);
    }
  });

  it("offers no tool that approves, applies, writes, publishes or deploys", () => {
    for (const name of Object.keys(TOOLS)) {
      expect(name).not.toMatch(/approve|apply|write|publish|deploy|merge|delete|update|set_/);
    }
    // draft_fix is the one name with "fix" in it: it drafts, and its kind says so.
    expect(TOOLS.draft_fix.kind).toBe("draft");
  });

  it("lists the same tools, with the same kind label, to a client", async () => {
    const { client, close } = await connect({
      root: process.cwd(),
      planBases: ["https://preview.harbourline.example"],
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const t of tools) {
      const kind = TOOLS[t.name as keyof typeof TOOLS].kind;
      expect(t.description?.startsWith(`[${kind}] `), t.name).toBe(true);
      expect(t._meta?.["gaugeline/kind"], t.name).toBe(kind);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    await close();
  });

  it("does not list plan_check unless the operator named a plan folder and an address to check against", async () => {
    for (const options of [
      {},
      { root: process.cwd() },
      { planBases: ["https://preview.harbourline.example"] },
    ]) {
      const { client, close } = await connect(options);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("plan_check");
      expect(names).toHaveLength(5);
      await close();
    }
  });

  it("never puts page text in a tool name or description", async () => {
    const { client, close } = await connect();
    const first = JSON.stringify((await client.listTools()).tools);
    // Descriptions are fixed text: asking again after other calls gives the same bytes.
    await client.callTool({ name: "list_checks", arguments: {} });
    expect(JSON.stringify((await client.listTools()).tools)).toBe(first);
    await close();
  });

  it("fails for a tool with no read or draft label", () => {
    expect(() => assertLabelled(TOOLS)).not.toThrow();
    expect(() => assertLabelled({ ...TOOLS, sneaky: { run: () => 1 } })).toThrow(/sneaky/);
    expect(() => assertLabelled({ ...TOOLS, wrong: { kind: "write" } })).toThrow(/wrong/);
    expect(() => assertLabelled({ ...TOOLS, empty: { kind: undefined } })).toThrow(/empty/);
  });

  it("clean case: every tool that returns page text says where, and the others say nothing", () => {
    expect(() => assertUntrustedSlots(TOOLS)).not.toThrow();
    for (const [name, def] of Object.entries(TOOLS)) {
      const slots: readonly string[] = def.untrustedSlots ?? [];
      expect(slots.length > 0, name).toBe(def.pageText);
    }
  });

  it("leak case: a new tool with page text and no declared slots is refused", () => {
    const tool = { kind: "read", pageText: true };
    expect(() => assertUntrustedSlots({ ...TOOLS, scan_page: tool })).toThrow(/scan_page/);
    expect(() =>
      assertUntrustedSlots({ ...TOOLS, scan_page: { ...tool, untrustedSlots: [] } }),
    ).toThrow(/scan_page/);
    expect(() =>
      assertUntrustedSlots({ ...TOOLS, scan_page: { ...tool, untrustedSlots: ["items[].text"] } }),
    ).not.toThrow();
  });

  it("refuses a slot that is not a path, a repeated slot, and slots on a tool with no page text", () => {
    const base = { kind: "read", pageText: true };
    for (const untrustedSlots of [["a b"], ["items[].text", "items[].text"], ["x; y"], [7]])
      expect(() => assertUntrustedSlots({ t: { ...base, untrustedSlots } })).toThrow(/t /);
    expect(() =>
      assertUntrustedSlots({ t: { kind: "read", pageText: false, untrustedSlots: ["a.b"] } }),
    ).toThrow(/pageText/);
  });

  it("tells a client where each tool's page text is, in fixed text, and never in the description", async () => {
    const { client, close } = await connect({
      root: process.cwd(),
      planBases: ["https://preview.harbourline.example"],
    });
    for (const t of (await client.listTools()).tools) {
      const def = TOOLS[t.name as keyof typeof TOOLS];
      expect(t._meta?.["gaugeline/untrustedSlots"], t.name).toEqual(def.untrustedSlots ?? []);
      for (const slot of def.untrustedSlots ?? []) expect(t.description).not.toContain(slot);
    }
    await close();
  });
});
