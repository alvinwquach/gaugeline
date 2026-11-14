import { isRecord } from "../connectors/get-json.js";
import { SANITY_TOKEN } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { clip, getProviderText, type ProviderAccess } from "../handoff/http.js";
import { VERCEL_TOKEN_VAR } from "../renewals/tokens.js";
import { DEFAULT_WINDOW } from "./config.js";
import { type Metric, type UsageProviderRead, dayBefore, utcDay, windowDays } from "./usage.js";

const VERCEL_API = "https://api.vercel.com";

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export interface UsageArgs {
  env: Env;
  fetcher: Fetcher;
  /** The injected clock: the days read are the complete UTC days before today. */
  now: Date;
  window?: number;
  teamId?: string | undefined;
}

/** The rows of a billing answer: one JSON object per line (JSON Lines), or one JSON array. Undefined when it is neither. */
function rowsOf(body: string): unknown[] | undefined {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  try {
    if (trimmed.startsWith("[")) {
      const all: unknown = JSON.parse(trimmed);
      return Array.isArray(all) ? all : undefined;
    }
    return trimmed
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Vercel's usage for a team or account, from its billing charges: one GET of
 * `GET /v1/billing/charges?from=<day>&to=<today>` (the complete days before today, UTC) with the token
 * the user set in GAUGELINE_VERCEL_TOKEN, in a header. The charges are FOCUS rows: for each service the
 * quantity consumed and its unit, and the billed cost, by day. Each service and its unit becomes a
 * metric, and the billed cost one more, all in thousandths so sums are exact. Vercel has no read-only
 * token type: use one scoped to the team, and revoke it when the work ends. The endpoint and the field
 * names (ServiceName, ConsumedQuantity, ConsumedUnit, BilledCost, BillingCurrency, ChargePeriodStart)
 * are from Vercel's billing documentation as remembered; the page was unreachable when this was written
 * (see Owner actions). An answer in any other shape is could-not-check, never a guess.
 */
export async function readVercelUsage(args: UsageArgs): Promise<UsageProviderRead> {
  const token = text(args.env[VERCEL_TOKEN_VAR]);
  if (!token)
    return {
      ok: false,
      provider: "Vercel",
      asked: false,
      configured: false,
      reason: `${VERCEL_TOKEN_VAR} is not set, so Vercel was not asked`,
    };
  const window = args.window ?? DEFAULT_WINDOW;
  const today = utcDay(args.now);
  const from = windowDays(dayBefore(today), window).at(-1) ?? dayBefore(today);
  const url =
    `${VERCEL_API}/v1/billing/charges?from=${encodeURIComponent(`${from}T00:00:00.000Z`)}` +
    `&to=${encodeURIComponent(`${today}T00:00:00.000Z`)}` +
    (args.teamId ? `&teamId=${encodeURIComponent(args.teamId)}` : "");
  const access: ProviderAccess = {
    provider: "Vercel",
    env: args.env,
    secretVars: [VERCEL_TOKEN_VAR],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const got = await getProviderText(access, url, "the billing charges");
  if (!got.ok)
    return { ok: false, provider: "Vercel", asked: true, configured: true, reason: got.reason };
  const rows = rowsOf(got.body);
  if (!rows)
    return {
      ok: false,
      provider: "Vercel",
      asked: true,
      configured: true,
      reason: "Vercel answered about the billing charges with something that is not JSON",
    };
  const series = new Map<string, Metric & { daily: Map<string, number> }>();
  const add = (name: string, unit: string, day: string, thousandths: number) => {
    const key = `${name}\u0000${unit}`;
    let metric = series.get(key);
    if (!metric) {
      metric = { name, unit, daily: new Map() };
      series.set(key, metric);
    }
    metric.daily.set(day, (metric.daily.get(day) ?? 0) + thousandths);
  };
  let understood = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const service = text(row.ServiceName);
    const start =
      typeof row.ChargePeriodStart === "string" ? Date.parse(row.ChargePeriodStart) : NaN;
    if (!service || Number.isNaN(start)) continue;
    understood++;
    const day = new Date(start).toISOString().slice(0, 10);
    const quantity = row.ConsumedQuantity;
    if (typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0)
      add(
        clip(service, 60),
        clip(text(row.ConsumedUnit) ?? "units", 20),
        day,
        Math.round(quantity * 1000),
      );
    const billed = row.BilledCost;
    if (typeof billed === "number" && Number.isFinite(billed))
      add(
        "Billed cost",
        clip(text(row.BillingCurrency) ?? "USD", 10),
        day,
        Math.round(billed * 1000),
      );
  }
  if (rows.length > 0 && understood === 0)
    return {
      ok: false,
      provider: "Vercel",
      asked: true,
      configured: true,
      reason:
        "Vercel answered about the billing charges with something Gaugeline cannot read (no row has a ServiceName and a ChargePeriodStart)",
    };
  return {
    ok: true,
    provider: "Vercel",
    metrics: [...series.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit),
    ),
  };
}

/**
 * Sanity's usage. Sanity shows it in the management dashboard, and Gaugeline could not confirm a
 * documented HTTP endpoint that returns it with a read-only token (the documentation was unreachable when
 * this was written), so nothing is asked and nothing is read from the dashboard: the answer is
 * could-not-check, with that reason, until an endpoint is confirmed. The reader is here so the check and
 * the report already list Sanity and say why.
 */
export function readSanityUsage(args: UsageArgs): Promise<UsageProviderRead> {
  if (!text(args.env[SANITY_TOKEN]))
    return Promise.resolve({
      ok: false,
      provider: "Sanity",
      asked: false,
      configured: false,
      reason: `${SANITY_TOKEN} is not set, so Sanity was not asked`,
    });
  return Promise.resolve({
    ok: false,
    provider: "Sanity",
    asked: false,
    configured: true,
    reason:
      "Sanity's usage figures are in its management dashboard, and Gaugeline has no documented read-only API for them to ask, so it does not read them and never reads a dashboard page",
  });
}
