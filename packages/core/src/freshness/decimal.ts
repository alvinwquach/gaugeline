/**
 * Decimal numbers as a whole number and a scale (27.3 is 273 and 1), so comparing a figure on a
 * page with a figure in a database never touches binary floating point: 28.1 - 27.9 is not 0.2 in a
 * float, and a tolerance of 0.2 must still accept it. BigInt is the whole number, so a count too
 * large for a float's exact range compares exactly too.
 */
export interface Decimal {
  /** The value times 10 to the scale. */
  units: bigint;
  scale: number;
}

export type Tolerance = { kind: "abs"; amount: Decimal } | { kind: "percent"; amount: Decimal };

const PLAIN = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function decimal(text: string): Decimal | undefined {
  const m = PLAIN.exec(text);
  if (!m) return undefined;
  const fraction = (m[3] ?? "").replace(/0+$/, "");
  const units = BigInt(`${m[2]}${fraction}`) * (m[1] === "-" ? -1n : 1n);
  return { units, scale: fraction.length };
}

/**
 * The number an element shows: "27.3", "1,234.5", "48.2%", "$12.50", "27.3 PPG". The whole text must
 * be the number, optionally with a currency sign in front and a percent sign or a unit word after it;
 * "27,3" (a decimal comma) and "27.3 and 28" are not read, because a guess here is a false finding.
 */
export function numberFrom(text: string): Decimal | undefined {
  const m =
    /^\s*[$\u20AC\u00A3]?\s*([+-]?[\d,]*\.?\d+|[+-]?\d[\d,]*\.?)\s*(?:%|[A-Za-z/.]{1,12})?\s*$/.exec(
      text.replace(/[\u00A0\u202F]/g, " "),
    );
  if (!m) return undefined;
  const raw = (m[1] ?? "").replace(/\.$/, "");
  if (raw.includes(",")) {
    if (!GROUPED.test(raw)) return undefined;
    return decimal(raw.replace(/,/g, ""));
  }
  return decimal(raw.startsWith(".") ? `0${raw}` : raw);
}

/** What a source returned as a number: a number or numeric text, never a boolean, null or exponent. */
export function valueOf(raw: unknown): Decimal | undefined {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return undefined;
    const text = String(raw);
    return PLAIN.test(text) ? decimal(text) : undefined;
  }
  if (typeof raw === "string") return numberFrom(raw.trim().replace(/%$/, ""));
  return undefined;
}

/** "0.5", "2%" or a number: an amount the page may differ by, or a share of the source's value. */
export function parseTolerance(raw: number | string): Tolerance | undefined {
  if (typeof raw === "number") {
    const d = valueOf(raw);
    return d && d.units >= 0n ? { kind: "abs", amount: d } : undefined;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(raw);
  const d = m ? decimal(m[1] ?? "") : undefined;
  if (!d) return undefined;
  return { kind: m?.[2] ? "percent" : "abs", amount: d };
}

function aligned(...values: Decimal[]): { units: bigint[]; scale: number } {
  const scale = Math.max(...values.map((v) => v.scale));
  return {
    units: values.map((v) => v.units * 10n ** BigInt(scale - v.scale)),
    scale,
  };
}

/** Whether the page's figure is within the tolerance of the source's. */
export function within(page: Decimal, source: Decimal, tolerance: Tolerance): boolean {
  const a = aligned(page, source);
  const [p = 0n, s = 0n] = a.units;
  const diff = p > s ? p - s : s - p;
  if (tolerance.kind === "abs") {
    const t = aligned({ units: diff, scale: a.scale }, tolerance.amount);
    return (t.units[0] ?? 0n) <= (t.units[1] ?? 0n);
  }
  // |page - source| / |source| <= percent / 100, kept in whole numbers:
  // diff * 100 * 10^pscale <= percentUnits * |source|
  const magnitude = s < 0n ? -s : s;
  return diff * 100n * 10n ** BigInt(tolerance.amount.scale) <= tolerance.amount.units * magnitude;
}

/** A decimal as plain text: "27.3". */
export function show(d: Decimal): string {
  const negative = d.units < 0n;
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, "0");
  const whole = digits.slice(0, digits.length - d.scale);
  const fraction = d.scale === 0 ? "" : `.${digits.slice(digits.length - d.scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
