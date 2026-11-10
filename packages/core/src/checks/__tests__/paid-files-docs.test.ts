import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { assetFilePublic } from "../asset-file-public.js";
import { checkoutJsOnly } from "../checkout-js-only.js";
import { PAGE_CHECKS } from "../index.js";
import { paidFilePublic } from "../paid-file-public.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/delivery.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (lang: string, title: string): string | undefined =>
  new RegExp(`\`\`\`${lang} title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

function snap(html: string, url: string) {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Docs example</title></head><body>${html}</body></html>`,
      ms: 1,
    },
  ]);
}

const ctx = { warn: () => undefined };

describe("docs/delivery.md: the paid file and unlinkable checkout sections", () => {
  it("the Press page findings are what the check returns for the page above them", async () => {
    const html = block("html", "Press page");
    expect(html).toBeDefined();
    const s = snap(html ?? "", "https://marlin-street-taproom.example/press/");
    const lines: string[] = [];
    for (const check of [paidFilePublic, assetFilePublic]) {
      for (const f of await check.run(s, ctx)) lines.push(`${f.checkId}: ${f.evidence}`);
    }
    expect(block("text", "Press page findings")).toBe(lines.join("\n"));
  });

  it("the Class page findings are what the check returns for the page above them", async () => {
    const html = block("html", "Class page");
    expect(html).toBeDefined();
    const s = snap(html ?? "", "https://tideline-coaching.example/class/");
    const lines: string[] = [];
    for (const check of [paidFilePublic, assetFilePublic, checkoutJsOnly]) {
      for (const f of await check.run(s, ctx)) lines.push(`${f.checkId}: ${f.evidence}`);
    }
    expect(block("text", "Class page findings")).toBe(lines.join("\n"));
  });

  it("names the three ids and the rules the checks keep", () => {
    for (const id of ["paid-file-public", "asset-file-public", "checkout-js-only"]) {
      expect(page).toContain(`\`${id}\``);
      expect(PAGE_CHECKS.some((c) => c.id === id)).toBe(true);
    }
    expect(page).toContain("never request the file");
    expect(page).toContain("The query string is dropped");
    expect(page).toContain("A signed address passes");
    expect(page).toContain("Terms and policies are low");
    expect(page).toContain('href="#"');
    expect(page).toContain("proposed");
  });
});
