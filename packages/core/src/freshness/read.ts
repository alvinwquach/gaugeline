import type { Env } from "../connectors/types.js";
import { parseSourceRef } from "../switches/config.js";
import { createSourceReader, type SourceDeps } from "../switches/source.js";
import type { FreshnessConfig } from "./config.js";
import { valueOf, type Decimal } from "./decimal.js";
import { parseMoment } from "./time.js";

/** What the run was told about freshness: the file, and the Sanity variables it may read, already copied. */
export interface FreshnessSettings {
  config: FreshnessConfig;
  env: Env;
}

export type SourceTime = { ok: true; at: number } | { ok: false; reason: string };
export type SourceFigure = { ok: true; value: Decimal } | { ok: false; reason: string };

/** What a freshness rule can ask the places the truth lives. Each source is read once per run. */
export interface Freshness {
  config: FreshnessConfig;
  /** When the source last changed (a newest sync time), as an instant. */
  sourceTime(source: string, now: number): Promise<SourceTime>;
  /** A figure from the source for a page: a one-row query, or the row whose `key` column is `key`. */
  sourceFigure(source: string, key: string): Promise<SourceFigure>;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/**
 * The reader behind `ctx.freshness`. Nothing here throws for a source being down: a source that
 * cannot be read, or that gives something that is not a time or a number, says why, and the check
 * lists that as could not check. It is never a pass and never a finding.
 */
export function createFreshness(settings: FreshnessSettings, deps: SourceDeps): Freshness {
  const reader = createSourceReader(settings.env, deps);
  const { redact, shown } = reader;
  const times = new Map<string, Promise<SourceTime>>();

  async function readTime(source: string, now: number): Promise<SourceTime> {
    const got = await reader.single(source);
    if (!got.ok) return { ok: false, reason: redact(got.reason) };
    const raw = typeof got.value === "number" ? String(got.value) : got.value;
    // A source time with no zone is UTC: that is what a database writes when it is not told otherwise.
    const moment = typeof raw === "string" ? parseMoment(raw, { now, timeZone: "UTC" }) : undefined;
    if (moment?.ok && (moment.moment.kind === "exact" || moment.moment.kind === "date"))
      return { ok: true, at: moment.moment.earliest };
    return {
      ok: false,
      reason: `${source} gave "${shown(got.value)}", which is not a date and time. Return a timestamp with a time zone, or an ISO 8601 string like 2026-11-10T09:30:00Z.`,
    };
  }

  return {
    config: settings.config,
    sourceTime(source, now) {
      let pending = times.get(source);
      if (!pending) {
        pending = readTime(source, now);
        times.set(source, pending);
      }
      return pending;
    },
    async sourceFigure(source, key) {
      const ref = parseSourceRef(source);
      const figure = (raw: unknown): SourceFigure => {
        const value = valueOf(raw);
        return value
          ? { ok: true, value }
          : {
              ok: false,
              reason: `${source} gave "${shown(raw)}", which is not a number.`,
            };
      };
      if (ref.kind === "sanity") {
        const got = await reader.single(source);
        return got.ok ? figure(got.value) : { ok: false, reason: redact(got.reason) };
      }
      const q = await reader.fromQuery(ref, source);
      if (!q.ok) return { ok: false, reason: redact(q.reason) };
      const { rows, columns } = q.result;
      if (rows.length === 0) return { ok: false, reason: `${source} returned no rows.` };
      const valueColumn = columns.includes("value")
        ? "value"
        : columns.length === 1
          ? columns[0]
          : undefined;
      if (rows.length === 1 && !columns.includes("key")) {
        if (valueColumn === undefined)
          return {
            ok: false,
            reason: `${source} returns ${columns.length} columns; name the figure "value" (select ... as value).`,
          };
        return figure(rows[0]?.[valueColumn] ?? null);
      }
      if (!columns.includes("key") || !columns.includes("value"))
        return {
          ok: false,
          reason: `${source} returns ${rows.length} rows; return one row, or columns named "key" and "value" so the page's own row can be found (key is the last part of the page's address).`,
        };
      const row = rows.find((r) => fold(String(r.key ?? "")) === fold(key));
      if (!row)
        return {
          ok: false,
          reason: `${source} has no row whose key is "${shown(key)}" (the last part of the page's address).`,
        };
      return figure(row.value ?? null);
    },
  };
}
