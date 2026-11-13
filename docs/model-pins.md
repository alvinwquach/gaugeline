# Pinned models: no model change runs until the evals have passed

A model's behaviour can change when its version does: a newer model may word a draft differently, or answer in a
shape an agent does not expect. So the model each tier uses is **pinned** in a file, and a change to it is
allowed to run only when the [eval suite](./agent-evals.md) has been run and its passing report recorded next to
it. This page describes the file, the check, and what the check does and does not prove. It is plain code: no
model, no key and no network are involved, and the same files give the same answer.

**Today.** The file format and the check are built and tested (row AG-24). **Not built.** There is no provider
behind [the model gateway](./model-gateway.md) yet, so nothing calls the check at run time. The worker or command
that builds a gateway calls `requireEvaluatedModels` first; that wiring lands with the provider adapter (AG-20)
and the routing (AG-21). See [what it proves](#what-it-proves-and-what-it-does-not) for the limits of the
offline suite the report comes from.

## The pins file

```json
{
  "schema": 1,
  "provider": "example",
  "tiers": { "fast": "small-model-2026-01", "strong": "large-model-2026-01" },
  "evalPass": {
    "tiers": { "fast": "small-model-2026-01", "strong": "large-model-2026-01" },
    "reportSha256": "<the SHA-256 of the report file, 64 hex characters>"
  }
}
```

| Field                   | Meaning                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `provider`              | the provider the models belong to; the gateway config must use the same one                        |
| `tiers`                 | the model id pinned for `fast`, `strong` or both: the only ids the gateway config may name         |
| `evalPass.tiers`        | the model ids the recorded pass was run for                                                        |
| `evalPass.reportSha256` | the SHA-256 of the exact bytes of the report file `gaugeline evals` wrote, as a person recorded it |

The file is strict. A setting it does not know is an error, an error says where the problem is and never repeats
what was written there, and it has no place for a key or a host.

## Changing a model

1. Change the id in `tiers`. Until the next steps are done, the check refuses it.
2. Run `gaugeline evals` and read the report. Every agent's golden cases must pass and every known-bad case must
   be caught. The red-team cases in the test suite ([agent evals](./agent-evals.md)) run in the normal test run
   and must be green too.
3. Hash the report: `sha256sum gaugeline-evals.json` (or `shasum -a 256 gaugeline-evals.json`). Keep the report
   file in the repository, next to the pins file, so the check can read it.
4. Record the new ids and the hash under `evalPass`. The model change and the record are one change, so a
   reviewer sees both.

## What the check refuses

It gives every reason it finds, in a fixed order, in fixed words and ids. A refusal is an error with the code
`could-not-run` (exit code 2 in a command): nothing is run on a model that was not evaluated.

- **No pass on record**, or a pinned tier the recorded pass does not cover.
- **A tier whose pinned id is not the id the pass was recorded for**, naming both.
- **The report file is not there**, is over 2 MiB, or is not byte for byte the file the recorded hash names (a
  trailing space is enough to change it).
- **The report is not a passing, whole-suite report.** A recorded hash cannot bless a failing report: the report
  must say it passed, every agent in it must have passed with no problem, and it must have a result for every
  agent that has an eval set. A run of one agent (`--agent`) is not the suite.
- **The gateway config does not match the pins**: another provider, a model that is not the pinned one, or a tier
  that is not pinned. A config that uses fewer tiers than are pinned is fine.

## Example: moving a bakery agent's fast tier to a newer model

Run from `packages/core` with `node --import tsx example.mts`:

```ts title=Example
import { createReplayModel, defineEvalSet, runEvalSets } from "./src/evals/index.js";
import { triage } from "./src/evals/example/triage.js";
import { reportSha256, requireEvaluatedModels } from "./src/model-gateway/index.js";

const out: string[] = [];
// `gaugeline evals` writes this file: here, for the example agent, offline from its recorded answers.
const set = defineEvalSet({
  agent: triage.agent,
  cases: triage.cases,
  model: () => createReplayModel(triage.recordings),
});
const report = `${JSON.stringify(await runEvalSets([set]), null, 2)}\n`;
const hash = reportSha256(report);
out.push(`report: ${report.split("\n").length - 1} lines, sha256 ${hash.slice(0, 12)}...`);

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
console.log(out.join("\n"));
```

```text title=Output
report: 148 lines, sha256 b86e2991a8a5...
the pinned models: allowed
a newer fast model: refused
  The pinned models are not allowed to run: the fast tier is pinned to small-model-2026-06 but the recorded eval pass was for small-model-2026-01.
new model, pass recorded: allowed
a report edited by hand: refused
  The pinned models are not allowed to run: the eval report does not match the hash recorded for the pass.
a report that is missing: refused
  The pinned models are not allowed to run: the eval report file named by the recorded pass was not found.
```

The first run is allowed. Moving the fast tier to a newer model with nothing else changed is refused, with the
ids named. Once the pass is recorded for the new id it is allowed. A report that was edited by hand, or is not
there, is refused. A test runs this same code and fails if this page's output differs from it.

## What it proves, and what it does not

- **It proves** that a passing, whole-suite eval report was recorded for these ids, that the file you have is the
  one that was recorded, and that no model id reaches the gateway config without that record.
- **It does not prove** that the report was produced by that model. The suite in this repository is offline: it
  replays recorded answers, so it writes the same bytes whatever model is pinned. The record is a person's, and a
  reviewer reads it in the same diff as the model change. A manual run on a live model (never in CI, and not built)
  would write a different report, and the hash would change.
- **It does not judge a new model.** Whether a draft is good is a person's call; a model's opinion is advisory or
  unsure and never a pass.
- **It does not read files or the environment.** The caller reads the pins file and the report and hands the text
  in.
