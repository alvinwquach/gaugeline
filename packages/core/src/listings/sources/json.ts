import type { Hop } from "../../fetcher.js";

export type Rec = Record<string, unknown>;

/** The body of an answer as JSON. Says what was wrong, never what the body held. */
export function jsonBody(hop: Hop, who: string): unknown {
  if (hop.truncated) throw new Error(`${who} answered with more than Gaugeline will read.`);
  try {
    return JSON.parse(hop.body ?? "") as unknown;
  } catch {
    throw new Error(`${who} did not answer with JSON.`);
  }
}

export function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A web address with no query or fragment, or undefined when it is not an http(s) address. */
export function plainUrl(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:"
      ? `${u.origin}${u.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

/** The dates from first to last, inclusive, as YYYY-MM-DD; at most `cap` of them. */
export function datesBetween(first: string, last: string, cap = 31): string[] {
  const out: string[] = [];
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end && out.length < cap; t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
