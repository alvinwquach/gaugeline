# Model budgets: a ceiling that stops a call before it is sent

If an agent ever words a draft for you with a model, the model costs money, and a loop or a very large payload
should not be able to spend more than you decided. This page describes the budget behind
[the model gateway](./model-gateway.md): three ceilings, a hard stop, and an estimate of what a run could cost
before it starts. It is plain code. **No model decides a budget**, and the same input gives the same answer.

**Today.** The ceilings, the estimate and the hard stop are built and tested (row AG-22). **Not built.** There
is still no provider behind the gateway, so nothing is spent: the example below uses the recorded fake. The
books are kept in memory, so they start again when the process does; a ledger that survives a restart for the
hosted worker needs a database table and is a separate, reviewed change. This is the "runaway cost" threat
(T7) in [the agent safety model](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0014-agent-safety-model.md).

## The three ceilings

| Ceiling              | What it limits                                                                         |
| -------------------- | -------------------------------------------------------------------------------------- |
| `perRunMicros`       | one run: every model call made through that run's budget                               |
| `perDayMicros`       | one UTC day: every run in every workspace the ledger keeps books for                   |
| `perWorkspaceMicros` | one workspace, from when the ledger began (a hosted ledger would keep this per period) |

Money is in **micro-units**: a million to the unit, whole numbers only, so there is no rounding to argue
about. A ceiling of 0 stops every call. A ceiling that is left out is an error: nothing here means "no limit".
These ceilings are about the model's cost. The per-agent cost ceiling in
[agent policy](./hosted/agent-policy.md) is a different, earlier check on what a call declares.

## The config

A budget file holds the three ceilings and the price of each model you use. Prices are micro-units for a
million tokens, one for the tokens you send and one for the tokens you get back. The file is strict, like the
gateway's: a setting it does not know (`apiKey`, `host`) is an error, and an error says where the problem is and
never repeats what was written there.

```json
{
  "ceilings": { "perRunMicros": 3000, "perDayMicros": 10000, "perWorkspaceMicros": 100000 },
  "prices": { "word-small": { "inputMicrosPerMTok": 250000, "outputMicrosPerMTok": 1250000 } }
}
```

The most a ceiling can be is 10^12 micro-units, and the most a price can be is 10^10. A model with no price
cannot be called: the budget refuses it before anything is sent, which is better than guessing it costs 0.

## What happens before a call

The gateway asks the budget before it sends anything, with the model, the number of input tokens (four
characters to a token, rounded up) and the most output tokens the call may produce. The budget:

1. Works out the **worst case**: every input token and every output token the call may use, at the model's
   price, rounded up to a whole micro-unit.
2. Refuses the call if that worst case, added to what the run, the day and the workspace have already spent,
   would pass any of the three ceilings. It checks the run first, then the day, then the workspace, and the
   reason names the one that stopped it and its ceiling (not what other workspaces spent).
3. Otherwise **holds** that amount, so a second call that starts while the first is waiting cannot also fit in
   the room for one.

After the answer, the hold is replaced by what the answer really cost: its recorded input and output tokens at
the model's prices. The cost the answer says about itself is not used. A call that never answered (a timeout)
stays counted at its worst case, because it may still have been billed.

## A hard stop

The first time a ceiling refuses a call, the run is **stopped**: every later call in it is refused too, even a
small one that would have fitted, so a loop cannot creep forward one cheap call at a time. A new run in the same
workspace starts with its own run ceiling, and the day and workspace totals carry on. A model with no price is
refused each time but does not stop the run, because that is a setting to fix and not a ceiling.

The day is a UTC day. The day's total starts again at midnight; the workspace's does not. If the clock goes
backwards the day does not, so spend never vanishes, and a clock that gives no usable time stops the call.

## The estimate before a run

`estimateRun` takes what a run plans to send, as sizes and not as text, and gives the most it could cost.
`ledger.canStart` checks that estimate against all three ceilings and what is already spent, and says no
before the run begins. It reserves nothing, and a run that makes no model call costs 0, so the deterministic
agents are never refused. A caller that starts anyway is still stopped call by call, as the example shows.

## Cost per approved draft

Each answered call hands its tokens and cost to `onSpend`. `traceFieldsOf` gives the two numbers
(`tokens` and `costMicros`) that go into the agent's trace record, and the
[agent scorecard](./hosted/agent-scorecard.md) already divides the cost in the trace by the number of approved
drafts. So the scorecard's column needs no change: it is blank before the first approval and measured after
it, and it becomes non-zero when a worker writes the cost of a model call into the trace. Writing that cost
is the worker's job when a provider exists (the trace writer, not this module).

## Example: wording notes for a bakery pop-up

Run from `packages/core` with `node --import tsx example.mts`:

```ts title=Example
import {
  ModelGatewayError,
  createBudgetLedger,
  createGateway,
  createRecordedAdapter,
  estimateRun,
  traceFieldsOf,
  type SpendEntry,
} from "./src/model-gateway/index.js";

// What a budget file holds: three ceilings and a price per model, in whole micro-units (10^6 to the unit).
const budget = {
  ceilings: { perRunMicros: 3_000, perDayMicros: 10_000, perWorkspaceMicros: 100_000 },
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
const findings = Array.from({ length: 18 }, (_, k) => ({
  id: `f-${k}`,
  checkId: "broken-link",
  title: "The menu link gives a 404",
  snippet: "menu link is broken. ".repeat(15).slice(0, 300),
}));
const note = { task: "Reword these findings for the owner.", findings };
for (const [callId, input] of [
  ["note-1", note],
  ["note-2", note],
  ["note-3", note],
  ["note-4", { task: "Hi" }],
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
console.log(out.join("\n"));
```

```text title=Output
estimate: 3 calls, 6000 input tokens, up to 3000 output tokens, at most 5250 micro-units
start the run: refused (the per-run ceiling of 3000 micro-units is below the estimate of 5250)
note-1: sent, the run has spent 700
note-2: sent, the run has spent 1400
note-3: refused (budget) The budget stopped the call: the per-run ceiling of 3000 micro-units would be passed.
note-4: refused (budget) The budget stopped the call: the run was already stopped by a ceiling.
2026-11-13: 2100 spent today, 2100 in the workspace
trace note-1: {"tokens":2000,"costMicros":700}
trace note-2: {"tokens":2000,"costMicros":700}
trace note-5: {"tokens":2000,"costMicros":700}
```

The first two notes cost 700 micro-units each (1800 tokens in and 200 out). The third could have cost 1750, and
1400 plus 1750 is over the run's 3000, so it was refused before the adapter saw it. The fourth was a tiny
prompt and was refused because the run was already stopped. The second run in the same workspace was
allowed: its own run ceiling started at zero, and the day's total (2100) is still well under 10000. A test runs
this same code and fails if this page's output differs from it.

## What it does not do

- It does not send anything or choose a model (the routing is AG-21), and it does not store a key.
- Its books are in memory. A restart starts them again, and two processes do not share them. Treat the
  ceilings as a safety stop in each process until a durable ledger exists.
- It trusts the token counts an adapter reports. An adapter that under-reports its usage is under-charged;
  the worst-case hold and the output limit are what bound a single call.
- Prices are yours to keep right. A price that is too low makes every ceiling too loose.
