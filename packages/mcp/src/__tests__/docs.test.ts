import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../registry.js";
import { connect, jsonOf } from "./helpers.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/mcp.md", import.meta.url)),
  "utf8",
);

describe("docs/mcp.md", () => {
  it("lists every tool in the registry with its kind, and no other tool", () => {
    const rows = [...page.matchAll(/^\| `([a-z_]+)`\s+\| `(read|draft)`/gm)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(Object.fromEntries(rows)).toEqual(
      Object.fromEntries(Object.entries(TOOLS).map(([n, d]) => [n, d.kind])),
    );
  });

  it("is no longer marked as not released", () => {
    expect(page).not.toMatch(/notReleased/);
  });

  it("names every slot the registry declares in the untrusted-text section", () => {
    const section = page.slice(page.indexOf("## Text from the site is data"));
    const row = (name: string) => new RegExp(`^\\| \`${name}\`.*$`, "m").exec(section)?.[0] ?? "";
    for (const name of Object.keys(TOOLS)) expect(row(name), name).not.toBe("");
    // Spelled out in full for these; plan_check and compare_runs say "the same" with their differences.
    for (const slot of TOOLS.run_check.untrustedSlots ?? [])
      expect(row("run_check")).toContain(`\`${slot}\``);
    for (const slot of TOOLS.explain_finding.untrustedSlots ?? [])
      expect(row("explain_finding")).toContain(`\`${slot}\``);
    for (const slot of ["file", "patch"]) expect(row("draft_fix")).toContain(`\`${slot}\``);
    expect(row("plan_check")).toContain("`findings[].group.key`");
    expect(row("compare_runs")).toContain("`new.findings[]`");
    expect(row("list_checks")).toMatch(/none/);
  });

  it("states the caps the code enforces", () => {
    expect(page).toMatch(/at most 120 characters, other text 300/);
    expect(page).toMatch(/at most 16 code points/);
    expect(page).toMatch(/50 plan lines/);
    expect(page).toMatch(/at most 40 leading spaces/);
  });

  it("the juice bar example prints what the real server returns for that page", async () => {
    const section = page.slice(page.indexOf("### An example: a hidden line"));
    const block = (title: string) =>
      new RegExp(`\`\`\`[a-z]+ title=${title}[^\\n]*\\n([\\s\\S]*?)\`\`\``).exec(section)?.[1] ??
      "";
    const html = block("Page");
    const printed = JSON.parse(block("Output")) as unknown;
    expect(html).toContain("<p hidden>");
    const site = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const c = await connect({ allowPrivate: true });
    try {
      const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
      const out = jsonOf<{ findings: { evidence: unknown; title: unknown }[] }>(
        await c.client.callTool({
          name: "run_check",
          arguments: { url, checks: ["hidden-ai-directive"] },
        }),
      );
      const first = out.findings[0];
      expect({ evidence: first?.evidence, title: first?.title }).toEqual(printed);
    } finally {
      await c.close();
      await new Promise((r) => site.close(r));
    }
  });
});
