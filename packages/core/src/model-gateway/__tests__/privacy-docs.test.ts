/**
 * The docs page for the privacy gate (AG-23): its example runs and prints what the page shows, every line of
 * its code is a line of the example, and the page states what the code does (every kind, every refusal, every
 * limit and every thing no rule can see), so the page cannot drift from the gate. The gate's files open no
 * connection and read no environment (the same scan as the boundary test).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../../__tests__/post-scan.js";
import {
  INPUT_REFUSALS,
  MODEL_INPUT_LIMITS,
  NOT_DETECTED,
  REDACTION_KINDS,
  WHAT_LEAVES,
  WHAT_STAYS,
} from "../privacy.js";
import { runPrivacyExample } from "../privacy-example.js";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const page = readFileSync(here("../../../../../docs/model-privacy.md"), "utf8");
const block = (title: string) =>
  new RegExp("```(?:text|ts)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];
const num = (n: number) => n.toLocaleString("en-US");
/** The page with its table padding collapsed, so a statement is found whatever the column widths. */
const flat = page.replace(/[ \t]+/g, " ");

describe("the example", () => {
  it("shows the output this code prints, word for word", async () => {
    expect(block("Output")).toBe(await runPrivacyExample());
  });

  it("shows code that is the example's own: every line of it is in privacy-example.ts", () => {
    const source = readFileSync(here("../privacy-example.ts"), "utf8");
    const shown = (block("Example") ?? "")
      .replace(/^import[\s\S]*?;\n/, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("console.log"));
    expect(shown.length).toBeGreaterThan(20);
    for (const line of shown) expect(source, line).toContain(line);
  });

  it("shows a payload with no key, no phone and no address in it, a withheld snippet and a page refused", async () => {
    const out = (await runPrivacyExample()).replace(/\n/g, " ");
    expect(out).toContain("sk_live_[redacted]");
    expect(out).toContain("[phone]");
    expect(out).toContain("[withheld]");
    expect(out).not.toContain("qqqq");
    expect(out).not.toContain("baker@");
    expect(out).not.toContain("7946");
    expect(out).toContain(
      "Would not send: the input is refused (whole-page at findings.0.snippet)",
    );
  });
});

describe("the page says what the code does", () => {
  it.each(REDACTION_KINDS.map((k, i) => [i + 1, k] as const))(
    "lists redaction %i, `%s`",
    (_, kind) => {
      expect(flat).toContain(`\`${kind}\``);
    },
  );

  it("lists the kinds in the order the code runs them", () => {
    const at = REDACTION_KINDS.map((k) => flat.indexOf(`| \`${k}\``));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it.each(INPUT_REFUSALS)("lists the refusal `%s`", (reason) => {
    expect(flat).toContain(`\`${reason}\``);
  });

  it.each(Object.entries(MODEL_INPUT_LIMITS))("states the limit %s = %s", (name, value) => {
    const seen = flat.includes(num(value)) || new RegExp(`\\b${value}\\b`).test(flat);
    expect(seen, name).toBe(true);
  });

  it.each([...WHAT_LEAVES, ...WHAT_STAYS, ...NOT_DETECTED])(
    "repeats, word for word: %s",
    (line) => {
      expect(flat).toContain(line);
    },
  );

  it("says in plain words that personal names cannot be found", () => {
    expect(page).toMatch(/cannot\*\* find these/);
    expect(NOT_DETECTED.some((l) => /personal names/.test(l))).toBe(true);
  });

  it("covers the three modes, and says mode 3 is not offered", () => {
    expect(page).toMatch(/1\. The command line/);
    expect(page).toMatch(/2\. Hosted/);
    expect(page).toMatch(/3\. A managed key \(parked\)/);
    expect(page).toMatch(/not offered/i);
  });
});

describe("the gate's files", () => {
  for (const f of ["privacy.ts", "privacy-example.ts"]) {
    const source = readFileSync(here(`../${f}`), "utf8");
    it(`${f} builds no request, opens no connection and reads no environment`, () => {
      expect(scan(`core/src/model-gateway/${f}`, source)).toEqual([]);
      expect(source).not.toMatch(/process\s*\.\s*env|process\[/);
    });
    it(`${f} reads no clock and calls no model of its own`, () => {
      expect(source).not.toMatch(/Date\.now|new Date\(|performance\.now|Math\.random/);
    });
  }
});
