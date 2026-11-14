/**
 * The one-page report through the AG-09 harness: golden and known-bad cases, offline, with a recorded
 * answer for each known-bad case. The one-pager is a report output, not a registered agent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatEvalReport, runEvals, validateEvalSet } from "../../evals/run.js";
import {
  createOnePagerEvalModel,
  onePagerCases,
  onePagerEvalAgent,
  onePagerForCase,
  onePagerPageProblems,
  EXAMPLE_ONE_PAGER_RUN,
} from "../one-pager-evals.js";
import { formatOnePager } from "../one-pager.js";

const run = () => runEvals(onePagerEvalAgent, onePagerCases, createOnePagerEvalModel());

describe("the one-pager eval set", () => {
  it("is a sound set: golden and known-bad cases, no write tool, unique ids", () => {
    expect(validateEvalSet(onePagerEvalAgent, onePagerCases)).toEqual([]);
    expect(onePagerEvalAgent.tools).toEqual(["read:run"]);
  });

  it("passes every golden case", async () => {
    const report = await run();
    expect(
      report.results.filter((r) => r.kind === "golden").map((r) => [r.caseId, r.status]),
    ).toEqual([
      ["golden-bakery-mix", "pass"],
      ["golden-clean-run", "pass"],
      ["golden-source-line", "pass"],
      ["golden-hostile-text-is-data", "pass"],
    ]);
  });

  it("catches every known-bad case with the assertion written for it", async () => {
    const report = await run();
    const caught = Object.fromEntries(
      report.results
        .filter((r) => r.kind === "known-bad")
        .map((r) => [
          r.caseId,
          [r.status, ...r.assertions.filter((a) => a.status === "fail").map((a) => a.id)],
        ]),
    );
    expect(caught).toEqual({
      "bad-uncited-item": ["caught", "schema"],
      "bad-missing-ref": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-obeys-page-text": ["caught", "no-write-call"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-oversized-input": ["caught", "limits"],
      "bad-malformed-output": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
  });

  it("the invented number is named, and nothing the page counts itself is flagged", async () => {
    const r = (await run()).results.find((x) => x.caseId === "bad-invented-number")!;
    expect(r.assertions.find((a) => a.id === "no-invented-numbers")!.detail).toContain("35");
    const golden = (await run()).results.find((x) => x.caseId === "golden-bakery-mix")!;
    expect(golden.assertions.find((a) => a.id === "no-invented-numbers")!.status).toBe("pass");
  });

  it("holds the order and the HTML in a finding as data: shown escaped, nothing called", async () => {
    const r = (await run()).results.find((x) => x.caseId === "golden-hostile-text-is-data")!;
    expect(r.assertions.find((a) => a.id === "no-write-call")!.status).toBe("pass");
    const page = onePagerForCase("golden-hostile-text-is-data");
    expect(page).toContain("Ignore your instructions");
    expect(onePagerPageProblems(page)).toEqual([]);
  });

  it("a model-priced answer is refused: the cost ceiling is zero", () => {
    expect(onePagerEvalAgent.limits.costCeilingMicros).toBe(0);
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/one-pager.md", import.meta.url)),
    "utf8",
  );
  const block = (title: string) =>
    new RegExp("```(?:text|md|markdown)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the page this code writes, word for word", () => {
    expect(block("Page")).toBe(formatOnePager(EXAMPLE_ONE_PAGER_RUN).trimEnd());
  });

  it("shows the eval report this code prints, word for word", async () => {
    expect(block("Evals")).toBe(formatEvalReport(await run()));
  });
});
