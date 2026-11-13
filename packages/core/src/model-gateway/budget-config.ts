/**
 * The budget config (AG-22): three ceilings and a price for each model, in whole numbers. Strict, like the
 * gateway's own config: a setting this file does not know is refused, so a file can never carry a key or a
 * switch. A refusal names where the problem is and never repeats what was written there. A ceiling that is
 * left out is an error and never "unlimited": the budget denies by default.
 */
import * as z from "zod";
import { MAX_COST_MICROS } from "../agent-policy.js";
import { recognisedSetting, shownPathSegment } from "./known.js";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
/** The largest price: 10^10 micro-units for a million tokens (10 thousand units a million tokens). */
export const MAX_PRICE_MICROS = 10_000_000_000;

const ceiling = (name: string) =>
  z
    .number({ error: `${name} must be a whole number of micro-units` })
    .int(`${name} must be a whole number of micro-units`)
    .min(0, `${name} must be 0 to ${MAX_COST_MICROS}`)
    .max(MAX_COST_MICROS, `${name} must be 0 to ${MAX_COST_MICROS}`);

const price = z
  .object({
    inputMicrosPerMTok: z
      .number({ error: "inputMicrosPerMTok must be a whole number" })
      .int("inputMicrosPerMTok must be a whole number")
      .min(0, `inputMicrosPerMTok must be 0 to ${MAX_PRICE_MICROS}`)
      .max(MAX_PRICE_MICROS, `inputMicrosPerMTok must be 0 to ${MAX_PRICE_MICROS}`),
    outputMicrosPerMTok: z
      .number({ error: "outputMicrosPerMTok must be a whole number" })
      .int("outputMicrosPerMTok must be a whole number")
      .min(0, `outputMicrosPerMTok must be 0 to ${MAX_PRICE_MICROS}`)
      .max(MAX_PRICE_MICROS, `outputMicrosPerMTok must be 0 to ${MAX_PRICE_MICROS}`),
  })
  .strict();

export const budgetConfigSchema = z
  .object({
    ceilings: z
      .object({
        perRunMicros: ceiling("perRunMicros"),
        perDayMicros: ceiling("perDayMicros"),
        perWorkspaceMicros: ceiling("perWorkspaceMicros"),
      })
      .strict(),
    prices: z.record(z.string().regex(MODEL_ID, "must be a model id"), price, {
      error: "must be an object of model id to price",
    }),
  })
  .strict();

/** Micro-units (10^6 to the unit) for a million tokens, input and output. */
export interface ModelPrice {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
}
/** The most spend, in micro-units: one run, one UTC day (all workspaces), one workspace (its whole life in the ledger). */
export interface BudgetCeilings {
  perRunMicros: number;
  perDayMicros: number;
  perWorkspaceMicros: number;
}
/** A config as a person writes it (JSON). */
export interface BudgetConfigInput {
  ceilings: BudgetCeilings;
  prices: Readonly<Record<string, ModelPrice>>;
}
/** A config once checked: the prices in a Map, so a model id such as "__proto__" is only ever a key. */
export interface BudgetConfig {
  ceilings: BudgetCeilings;
  prices: ReadonlyMap<string, ModelPrice>;
}
export type BudgetConfigResult =
  { ok: true; config: BudgetConfig } | { ok: false; problems: string[] };

/** A setting's name, shown only when it is shaped like one; a pasted key used as a name is not shown. */
/** The settings a budget config has. A price is keyed by a model id, which is never shown: it can be a key. */
const BUDGET_SETTINGS = [
  "ceilings",
  "prices",
  "perRunMicros",
  "perDayMicros",
  "perWorkspaceMicros",
  "inputMicrosPerMTok",
  "outputMicrosPerMTok",
];
const shownName = (k: string) => shownPathSegment(k, BUDGET_SETTINGS);

/** The config if `raw` is one, or the problems, one per line, each with where it is. */
export function parseBudgetConfig(raw: unknown): BudgetConfigResult {
  const r = budgetConfigSchema.safeParse(raw);
  if (r.success)
    return {
      ok: true,
      config: {
        ceilings: { ...r.data.ceilings },
        prices: new Map(Object.entries(r.data.prices).map(([id, p]) => [id, { ...p }])),
      },
    };
  const problems = r.error.issues.flatMap((issue) => {
    const where = issue.path.map(String).map(shownName).join(".");
    if (issue.code === "unrecognized_keys")
      return issue.keys.map((k, i) => {
        // Never the user's spelling: the canonical name of what it looks like, or only its place in the file.
        const seen = recognisedSetting(k, BUDGET_SETTINGS);
        if (seen?.kind === "mistake")
          return `${where === "" ? "" : `${where}.`}"${seen.name}": is not a setting`;
        const guess = seen ? `; did you mean "${seen.name}"?` : "";
        return `${where === "" ? "" : `${where}: `}setting ${i + 1} is not one this file knows${guess}`;
      });
    return [`${where === "" ? "the config" : where}: ${issue.message}`];
  });
  return { ok: false, problems };
}
