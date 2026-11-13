/**
 * The program shown on docs/model-budgets.md. A test runs it and compares what it returns with the page, word
 * for word, and checks that every line of the page's code is a line of this file.
 */
import {
  ModelGatewayError,
  createBudgetLedger,
  createGateway,
  createRecordedAdapter,
  estimateRun,
  traceFieldsOf,
  type SpendEntry,
} from "./index.js";

export async function runBudgetExample(): Promise<string> {
  // What a budget file holds: three ceilings and a price per model, in whole micro-units (10^6 to the unit).
  const budget = {
    ceilings: { perRunMicros: 2_800, perDayMicros: 10_000, perWorkspaceMicros: 100_000 },
    prices: { "word-small": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 } },
  };
  const out: string[] = [];

  // Before the run: the most it could cost, from the size of what it plans to send.
  const plan = Array.from({ length: 3 }, () => ({
    tier: "fast" as const,
    model: "word-small",
    inputChars: 8_000,
    maxOutputTokens: 1_000,
  }));
  const estimate = estimateRun(budget, plan);
  if (!estimate.ok) throw new Error("a model has no price");
  out.push(
    `estimate: ${estimate.calls.length} calls, ${estimate.inputTokens} input tokens, up to ${estimate.outputTokens} output tokens, at most ${estimate.costMicros} micro-units`,
  );

  // The ledger keeps the books. The caller hands it the time; it has no clock of its own.
  const spent: SpendEntry[] = [];
  const ledger = createBudgetLedger({
    config: budget,
    now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
    onSpend: (entry) => spent.push(entry),
  });
  const start = ledger.canStart("popup-bakery", estimate);
  out.push(`start the run: ${start.allowed ? "allowed" : `refused (${start.reason})`}`);

  // One answer a model gave once: 1800 tokens in, 200 out.
  const answer = {
    text: "The menu link is broken.",
    usage: { inputTokens: 1_800, outputTokens: 200, costMicros: 0, latencyMs: 300 },
  };
  const gateway = (run: ReturnType<typeof ledger.forRun>) =>
    createGateway({
      config: { provider: "recorded", tiers: { fast: "word-small" } },
      adapters: [
        createRecordedAdapter(
          new Map(["note-1", "note-2", "note-3", "note-4", "note-5"].map((id) => [id, answer])),
        ),
      ],
      env: () => ({}),
      budget: run,
    });
  const run = ledger.forRun("popup-bakery");
  const words = gateway(run);

  // The caller may go ahead anyway; the gateway still stops the call that could pass the ceiling.
  const findings = Array.from({ length: 10 }, (_, k) => ({
    id: `f-${k}`,
    title: "The menu link gives a 404",
    snippet: "menu link is broken. ".repeat(15).slice(0, 200),
  }));
  const note = { task: { template: "reword-findings" }, findings } as const;
  for (const [callId, input] of [
    ["note-1", note],
    ["note-2", note],
    ["note-3", note],
    ["note-4", { task: { template: "reword-findings" } }],
  ] as const) {
    try {
      await words.complete({ tier: "fast", agentId: "triage", callId, input });
      out.push(`${callId}: sent, the run has spent ${run.committedMicros()}`);
    } catch (err) {
      if (!(err instanceof ModelGatewayError)) throw err;
      out.push(`${callId}: refused (${err.code}) ${err.message}`);
    }
  }

  // A second run in the same workspace starts its own run ceiling; the day's total carries on.
  await gateway(ledger.forRun("popup-bakery")).complete({
    tier: "fast",
    agentId: "triage",
    callId: "note-5",
    input: note,
  });
  const book = ledger.snapshot("popup-bakery");
  out.push(`${book.day}: ${book.dayMicros} spent today, ${book.workspaceMicros} in the workspace`);

  // What the trace of each call holds, so the scorecard's cost per approved draft is a measured figure.
  for (const e of spent) out.push(`trace ${e.callId}: ${JSON.stringify(traceFieldsOf(e))}`);
  return out.join("\n");
}
