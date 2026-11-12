import { forMarkdown, forSlack, type Finding } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { cell, planStepSummary, summaryRow } from "../step-summary.js";

const hostile: Finding = {
  checkId: "plan-redirect-loop",
  severity: "high",
  title: "[login](https://evil.example) @acme/sec",
  evidence: "<img src=https://evil.example/p.gif> **x** | y",
  url: "https://bar.example/",
};

describe("step summary: page text is escaped Markdown", () => {
  it("a hostile title and evidence make no link, image, bold or extra column", () => {
    const md = planStepSummary({
      file: "plan.csv",
      rows: 1,
      findings: [hostile],
      couldNotCheck: 0,
    });
    const row = md.split("\n").find((l) => l.includes("login")) ?? "";
    expect(row).toContain("\\[login\\]\\(https://evil.example\\) @acme/sec");
    expect(row).toContain("\\<img src=https://evil.example/p.gif\\> \\*\\*x\\*\\* \\| y");
    expect(row.split(/(?<!\\)\|/u)).toHaveLength(6);
  });

  it("cell keeps the pipe escape and flattens line breaks", () => {
    expect(cell("a|b\nc")).toBe("a\\|b c");
  });

  it("type test: a row takes only Markdown-escaped text", () => {
    // @ts-expect-error a raw string from a page cannot reach the row
    summaryRow("1", "high", "[x](https://evil.example)", forMarkdown("e"));
    // @ts-expect-error text escaped for Slack is not escaped for Markdown
    summaryRow("1", "high", forMarkdown("t"), forSlack("e"));
    expect(summaryRow("1", "high", cell("t"), cell("e"))).toBe("| 1 | Fix this first | t | e |");
  });
});
