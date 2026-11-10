/**
 * Money as whole numbers of minor units (cents, pence). A price is never a float: 19.99 is read as
 * the text "19.99", split at the point and built into the integer 1999, so it can never come out
 * as 1998. G23e extends this file with currencies; this branch adds only `toMinor`.
 */

const DECIMAL = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * A price in major units ("48", "48.00", 48, 19.99, "1,299.00") as a whole number of minor units,
 * assuming two decimal places. A fraction longer than two places is refused unless the extra places
 * are zeros ("48.500" is 4850; "48.123" throws). A negative, empty, non-numeric or unsafe-sized
 * value throws a RangeError.
 */
export function toMinor(value: string | number): number {
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
  const whole = (m[1] ?? "").replace(/,/g, "");
  let fraction = m[2] ?? "";
  if (fraction.length > 2) {
    if (/[1-9]/.test(fraction.slice(2)))
      throw new RangeError("A price has at most two decimal places.");
    fraction = fraction.slice(0, 2);
  }
  const minor = Number(whole + fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new RangeError("That price is too large to compare.");
  return minor;
}
