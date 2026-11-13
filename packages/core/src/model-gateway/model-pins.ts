/**
 * Pinned model versions (AG-24, ADR-0014 "evals that fail closed"). A small file pins the model id of each
 * tier and records the eval pass that covers them: the SHA-256 of the report file `gaugeline evals` wrote
 * and the ids that pass was for. A model that changed without a matching record, a report that does not
 * hash to the record, or a report that is not a whole, passing suite is refused as "could not run" before a
 * gateway is built from the config.
 *
 * Pure and deterministic: the caller reads the files and hands the text in. No file, clock, key, model or
 * network. The record is made by a person and read by a reviewer in the same diff as the model change; it
 * proves a green suite was recorded for these ids, not that the report was produced by that model (the
 * offline suite replays recorded answers), and docs/model-pins.md says so.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import { CouldNotRunError } from "../errors.js";
import { EVAL_SETS } from "../evals/registry.js";
import { EVAL_SUITE_SCHEMA } from "../evals/suite.js";
import { parseGatewayConfig } from "./config.js";
import { recognisedSetting, shownAnyModelId, shownModelId, shownPathSegment } from "./known.js";
import { MODEL_TIERS, type GatewayConfigInput, type ModelTier } from "./types.js";

export const MODEL_PINS_SCHEMA = 1;
/** The largest report file read: the suite's report is a few kilobytes a case. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const modelId = z.string({ error: "must be a model id" }).regex(MODEL_ID, "must be a model id");
const tiers = (atLeastOne: boolean) => {
  const t = z
    .object(Object.fromEntries(MODEL_TIERS.map((n) => [n, modelId.optional()])), {
      error: "must be an object of tier to model id",
    })
    .strict();
  return atLeastOne
    ? t.refine(
        (v) => Object.values(v).some((x) => x !== undefined),
        "must pin a model for at least one tier",
      )
    : t;
};

export const modelPinsSchema = z
  .object({
    schema: z.literal(MODEL_PINS_SCHEMA, { error: `must be ${MODEL_PINS_SCHEMA}` }),
    provider: z
      .string({ error: "must be a provider name" })
      .regex(PROVIDER, "must be a provider name"),
    tiers: tiers(true),
    evalPass: z
      .object({
        tiers: tiers(false),
        reportSha256: z
          .string({ error: "must be 64 lower-case hex characters" })
          .regex(SHA256, "must be 64 lower-case hex characters"),
      })
      .strict()
      .optional(),
  })
  .strict();

type TierIds = Partial<Record<ModelTier, string>>;
/** What the pins file holds. `evalPass` is what a person records after `gaugeline evals` is green. */
export interface ModelPins {
  schema: typeof MODEL_PINS_SCHEMA;
  provider: string;
  tiers: TierIds;
  evalPass?: { tiers: TierIds; reportSha256: string };
}
export type ModelPinsResult = { ok: true; pins: ModelPins } | { ok: false; problems: string[] };

/** The settings a pins file has. A name is shown only if it is one of them (or a recognised mistake): a key can be a name. */
const PIN_SETTINGS = ["schema", "provider", "tiers", "evalPass", "reportSha256", "fast", "strong"];
const shownName = (k: string) => shownPathSegment(k, PIN_SETTINGS);

/** The pins if `raw` is a pins file, or the problems, each with where it is and never what was written. */
export function parseModelPins(raw: unknown): ModelPinsResult {
  const r = modelPinsSchema.safeParse(raw);
  if (r.success) return { ok: true, pins: r.data as ModelPins };
  const problems = r.error.issues.flatMap((issue) => {
    const where = issue.path.map(String).map(shownName).join(".");
    if (issue.code === "unrecognized_keys")
      return issue.keys.map((k, i) => {
        // Never the user's spelling: the canonical name of what it looks like, or only its place in the file.
        const seen = recognisedSetting(k, PIN_SETTINGS);
        if (seen?.kind === "mistake")
          return `${where === "" ? "" : `${where}.`}"${seen.name}": is not a setting`;
        const guess = seen ? `; did you mean "${seen.name}"?` : "";
        return `${where === "" ? "" : `${where}: `}setting ${i + 1} is not one this file knows${guess}`;
      });
    return [`${where === "" ? "the pins file" : where}: ${issue.message}`];
  });
  return { ok: false, problems };
}

/** The SHA-256 of a report file's exact bytes (its text as UTF-8), lower-case hex. */
export const reportSha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type ModelPinsVerdict = { ok: true } | { ok: false; reasons: string[] };

/** True when `text` is the whole-suite report of a passing run and has a result for every agent in `agents`. */
function reportProblem(text: string, agents: readonly string[]): string | null {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return "the eval report is not a passing report";
  }
  const r = report as { schema?: unknown; ok?: unknown; agents?: unknown } | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.schema !== EVAL_SUITE_SCHEMA ||
    r.ok !== true ||
    !Array.isArray(r.agents) ||
    r.agents.length === 0
  )
    return "the eval report is not a passing report";
  const rows = r.agents as { agentId?: unknown; ok?: unknown; problems?: unknown }[];
  if (
    !rows.every(
      (a) =>
        a !== null &&
        typeof a === "object" &&
        typeof a.agentId === "string" &&
        a.ok === true &&
        Array.isArray(a.problems) &&
        a.problems.length === 0,
    )
  )
    return "the eval report is not a passing report";
  const have = new Set(rows.map((a) => a.agentId));
  const missing = agents.find((id) => !have.has(id));
  return missing === undefined ? null : `the eval report has no result for the agent ${missing}`;
}

/**
 * Whether the pinned models may run. `reportText` is the report file the recorded pass names (undefined when
 * it is not there). `agents` are the agents the report must cover: every agent that ships an eval set, unless
 * named. Reasons are fixed words and ids; nothing from the report is repeated.
 */
export function checkModelPins(input: {
  pins: ModelPins;
  reportText: string | undefined;
  agents?: readonly string[];
}): ModelPinsVerdict {
  const { pins } = input;
  const pass = pins.evalPass;
  if (!pass) return { ok: false, reasons: ["no eval pass is recorded for the pinned models"] };
  const reasons: string[] = [];
  for (const tier of MODEL_TIERS) {
    const pinned = pins.tiers[tier];
    if (pinned === undefined) continue;
    const passed = pass.tiers[tier];
    if (passed === undefined)
      reasons.push(`the ${tier} tier is pinned but the recorded eval pass does not cover it`);
    else if (passed !== pinned)
      reasons.push(
        `the ${tier} tier is pinned to ${shownAnyModelId(pinned)} but the recorded eval pass was for ${shownAnyModelId(passed)}`,
      );
  }
  const text = input.reportText;
  if (text === undefined)
    reasons.push("the eval report file named by the recorded pass was not found");
  else if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES)
    reasons.push("the eval report is over 2 MiB");
  else if (reportSha256(text) !== pass.reportSha256)
    reasons.push("the eval report does not match the hash recorded for the pass");
  else {
    const problem = reportProblem(text, input.agents ?? EVAL_SETS.map((s) => s.agentId));
    if (problem) reasons.push(problem);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const HINT =
  "Run gaugeline evals, then record the report's SHA-256 and the model ids in the pinned models file.";

/**
 * The gateway config, if its provider and models are the pinned ones and the pins have a passing eval pass
 * on record. Anything else is a CouldNotRunError (code "could-not-run") naming what is wrong. Build the
 * gateway from what this returns, so a model that was never evaluated cannot be reached.
 */
export function requireEvaluatedModels(input: {
  config: GatewayConfigInput;
  pinsText: string;
  reportText: string | undefined;
  agents?: readonly string[];
}): GatewayConfigInput {
  const refuse = (what: string): never => {
    throw new CouldNotRunError(what, { hint: HINT });
  };
  let raw: unknown;
  try {
    raw = JSON.parse(input.pinsText);
  } catch {
    return refuse("The pinned models file is not valid JSON.");
  }
  const pinned = parseModelPins(raw);
  if (!pinned.ok)
    return refuse(`The pinned models file is not valid: ${pinned.problems.join("; ")}.`);
  const config = parseGatewayConfig(input.config);
  if (!config.ok) return refuse(`The model config is not valid: ${config.problems.join("; ")}.`);
  const { pins } = pinned;
  const reasons: string[] = [];
  if (config.config.provider !== pins.provider)
    reasons.push("the config's provider is not the pinned provider");
  for (const tier of MODEL_TIERS) {
    const used = config.config.tiers[tier];
    if (used === undefined) continue;
    const pin = pins.tiers[tier];
    if (pin === undefined) reasons.push(`the ${tier} tier is not pinned`);
    else if (pin !== used)
      reasons.push(
        `the ${tier} tier is configured as ${shownModelId(config.config.provider, used)} but pinned to ${shownModelId(pins.provider, pin)}`,
      );
  }
  const verdict = checkModelPins({
    pins,
    reportText: input.reportText,
    ...(input.agents ? { agents: input.agents } : {}),
  });
  if (!verdict.ok) reasons.push(...verdict.reasons);
  if (reasons.length > 0)
    refuse(`The pinned models are not allowed to run: ${reasons.join("; ")}.`);
  return input.config;
}
