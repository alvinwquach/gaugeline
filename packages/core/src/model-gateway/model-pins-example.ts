/**
 * The program shown on docs/model-pins.md. A test runs it and compares what it returns with the page, word
 * for word, and checks that every line of the page's code is a line of this file.
 */
import { createReplayModel, defineEvalSet, runEvalSets } from "../evals/index.js";
import { triage } from "../evals/example/triage.js";
import { reportSha256, requireEvaluatedModels } from "./index.js";

export async function runModelPinsExample(): Promise<string> {
  const out: string[] = [];
  // `gaugeline evals` writes this file: here, for the example agent, offline from its recorded answers.
  const set = defineEvalSet({
    agent: triage.agent,
    cases: triage.cases,
    model: () => createReplayModel(triage.recordings),
  });
  const report = `${JSON.stringify(await runEvalSets([set]), null, 2)}\n`;
  const hash = reportSha256(report);
  out.push(`report: ${report.split("\n").length - 1} lines, sha256 ${hash.slice(0, 10)}...`);

  // The pins file: the model of each tier, and the pass that covers them (a person records it).
  const passed = { fast: "small-model-2026-01", strong: "large-model-2026-01" };
  const pins = {
    schema: 1,
    provider: "example",
    tiers: passed,
    evalPass: { tiers: passed, reportSha256: hash },
  };
  // What the code asks the gateway for: the same provider and tiers.
  const config = { provider: "example", keyEnv: "EXAMPLE_API_KEY", tiers: passed };
  const agents = ["triage"];

  const attempt = (label: string, run: () => unknown) => {
    try {
      run();
      out.push(`${label}: allowed`);
    } catch (err) {
      out.push(`${label}: refused`);
      out.push(`  ${(err as Error).message}`);
    }
  };
  const ask = (c: object, p: object, r: string | undefined) =>
    requireEvaluatedModels({
      config: c as never,
      pinsText: JSON.stringify(p),
      reportText: r,
      agents,
    });

  attempt("the pinned models", () => ask(config, pins, report));

  // Someone moves the fast tier to a newer model and nothing else.
  const newer = { ...passed, fast: "small-model-2026-06" };
  attempt("a newer fast model", () =>
    ask({ ...config, tiers: newer }, { ...pins, tiers: newer }, report),
  );

  // The suite is run again (offline it writes the same bytes) and the pass is recorded with the new id.
  const recorded = { ...pins, tiers: newer, evalPass: { tiers: newer, reportSha256: hash } };
  attempt("new model, pass recorded", () => ask({ ...config, tiers: newer }, recorded, report));

  // The report is edited by hand to look better.
  attempt("a report edited by hand", () =>
    ask(config, pins, report.replace('"ok": true', '"ok": false')),
  );
  attempt("a report that is missing", () => ask(config, pins, undefined));
  return out.join("\n");
}
