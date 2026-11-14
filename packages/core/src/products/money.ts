/**
 * Money as whole numbers of minor units (cents, pence, yen). A price is never a float: 19.99 is read
 * as the text "19.99", split at the point and built into the integer 1999, so it can never come out
 * as 1998. How many places a currency has after the point comes from a small table (below).
 */

/** An amount in whole minor units and the currency it is in, lower-case ISO 4217 ("usd"). */
export interface Money {
  amount: number;
  currency: string;
}

/**
 * Places after the point for the currencies that do not have two. A Map: one lookup per price, and
 * the currency code is the whole key. Proposed (the spec names these four): a currency that is not
 * here is read with two places, so the table is also where a currency is added.
 */
const EXPONENTS: ReadonlyMap<string, number> = new Map([
  ["jpy", 0],
  ["krw", 0],
  ["bhd", 3],
  ["kwd", 3],
]);

/** Places after the point in a currency's minor unit: 0 for jpy and krw, 3 for bhd and kwd, else 2. */
export function minorExponent(currency?: string): number {
  return EXPONENTS.get((currency ?? "").trim().toLowerCase()) ?? 2;
}

const DECIMAL = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * A price in major units ("48", "48.00", 48, 19.99, "1,299.00") as a whole number of minor units.
 * The text is split at the point and the fraction is padded to the currency's places; it is never
 * multiplied. Without a currency, or with one that is not in the table, there are two places. A
 * fraction longer than the currency allows is refused unless the extra places are zeros ("48.500"
 * is 4850 in usd; "48.123" throws; "500.5" throws in jpy). A negative, empty, non-numeric or
 * unsafe-sized value throws a RangeError.
 */
export function toMinor(value: string | number, currency?: string): number {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("A price must be a finite number.");
    // String() gives the shortest text that reads back as the same number: 19.99 stays "19.99".
    // Exponent notation (1e-7, 1e21) is not a price anyone typed.
    text = String(value);
    if (/e/i.test(text)) throw new RangeError("A price must be a plain decimal number.");
  } else {
    text = value.trim();
  }
  const m = DECIMAL.exec(text);
  if (!m) throw new RangeError("A price must be a plain decimal number such as 48 or 48.00.");
  const places = minorExponent(currency);
  const whole = (m[1] ?? "").replace(/,/g, "");
  let fraction = m[2] ?? "";
  if (fraction.length > places) {
    if (/[1-9]/.test(fraction.slice(places)))
      throw new RangeError(
        `A price in ${currency ? currency.toLowerCase() : "this currency"} has at most ${places} decimal ${places === 1 ? "place" : "places"}.`,
      );
    fraction = fraction.slice(0, places);
  }
  const minor = Number(whole + fraction.padEnd(places, "0"));
  if (!Number.isSafeInteger(minor)) throw new RangeError("That price is too large to compare.");
  return minor;
}

/**
 * An amount for a message: "48.00 USD", "500 JPY", "1.250 KWD". Display only; nothing compares
 * these strings. Built from the integer with the currency's places, so it can never show a rounded
 * float. No currency shows the number alone.
 */
export function formatMoney(m: Money): string {
  const places = minorExponent(m.currency);
  const sign = m.amount < 0 ? "-" : "";
  const digits = String(Math.abs(m.amount)).padStart(places + 1, "0");
  const number =
    places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(digits.length - places)}`;
  return m.currency.trim() === ""
    ? `${sign}${number}`
    : `${sign}${number} ${m.currency.toUpperCase()}`;
}
