import { describe, expect, it } from "vitest";
import { createBudget, type Finding, type RunResult } from "@gaugeline/core";
import { failedLine, formatTerminal, summaryLine } from "../reporter.js";

const f = (
  checkId: string,
  severity: Finding["severity"],
  title: string,
  evidence: string,
): Finding => ({
  checkId,
  severity,
  title,
  evidence,
  url: "https://shop.example/",
});
const result = (r: Partial<RunResult>): RunResult => ({
  findings: [],
  passed: [],
  failed: [],
  warnings: [],
  couldNotCheck: [],
  ...r,
});

describe("terminal reporter: unit", () => {
  it("clean run", () => {
    expect(
      formatTerminal({
        result: result({ passed: ["noindex", "canonical-missing"] }),
        color: false,
      }),
    ).toBe(["✓ noindex", "✓ canonical-missing", "", "Nothing to look at.", ""].join("\n"));
  });

  it("mixed run", () => {
    const budget = createBudget();
    budget.take(
      "links",
      Array.from({ length: 61 }, (_, i) => i),
    );
    const out = formatTerminal({
      result: result({
        findings: [
          f(
            "noindex",
            "high",
            "This page asks search engines not to list it",
            '<meta name="robots" content="noindex">',
          ),
          f(
            "redirect-chain",
            "medium",
            "Your address takes several jumps to load",
            "2 redirects: a -> b -> c",
          ),
          f(
            "canonical-missing",
            "low",
            "The page doesn't say which address is the real one",
            "no canonical",
          ),
        ],
        passed: ["thin-html"],
      }),
      sampled: budget.summary(),
      color: false,
    });
    expect(out).toBe(
      [
        "✗ This page asks search engines not to list it",
        '    <meta name="robots" content="noindex">',
        "! Your address takes several jumps to load",
        "    2 redirects: a -> b -> c",
        "· The page doesn't say which address is the real one",
        "    no canonical",
        "✓ thin-html",
        "",
        "Checked 30 of 61 links.",
        "3 to look at, 1 to fix first.",
        "",
      ].join("\n"),
    );
  });

  it("failed check", () => {
    const out = formatTerminal({
      result: result({ passed: ["noindex"], failed: [{ id: "host-duplicate", error: "boom" }] }),
      color: false,
    });
    expect(out).toBe(
      ["✓ noindex", "? 1 check could not run: host-duplicate", "", "Nothing to look at.", ""].join(
        "\n",
      ),
    );
  });

  it("colour adds ANSI codes; without colour there are none", () => {
    const r = result({ findings: [f("noindex", "high", "t", "e")] });
    expect(formatTerminal({ result: r, color: true })).toContain("\u001b[31m");
    expect(formatTerminal({ result: r, color: false })).not.toContain("\u001b[");
  });

  it("summary line: 0, 1 and many", () => {
    expect(summaryLine([])).toBe("Nothing to look at.");
    expect(summaryLine([{ severity: "high" }])).toBe("1 to look at, 1 to fix first.");
    expect(summaryLine([{ severity: "medium" }])).toBe("1 to look at, none to fix first.");
    expect(summaryLine([{ severity: "high" }, { severity: "high" }, { severity: "low" }])).toBe(
      "3 to look at, 2 to fix first.",
    );
    expect(failedLine(1)).toBe("1 check could not run");
    expect(failedLine(2)).toBe("2 checks could not run");
  });
});
