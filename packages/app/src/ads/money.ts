/**
 * Money from a minor-unit integer (cents, yen) and a currency code, for display only.
 *
 * Spend is added and sorted as integers everywhere else, so the sum is exact. Here the integer is
 * turned into a decimal string by moving the point `fractionDigits` places (a string operation, not a
 * division) and handed to Intl.NumberFormat, which accepts a decimal string and formats it without
 * going through a float. The number of places comes from the currency itself: 2 for USD and EUR,
 * 0 for JPY, 3 for KWD.
 */
export function formatMoney(minor: number, currency: string | null, locale?: string): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError("Spend must be a whole number of the currency's smallest unit.");
  const formatter = numberFormat(currency, locale);
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const negative = minor < 0;
  const padded = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = padded.slice(0, padded.length - digits);
  const fraction = padded.slice(padded.length - digits);
  const text = `${negative ? "-" : ""}${whole}${digits > 0 ? `.${fraction}` : ""}`;
  // The ES2023 signature takes a decimal string; the bundled DOM typings only know numbers.
  return formatter.format(text as unknown as number);
}

/**
 * The formatter for a currency. No code, or one Intl refuses, is a plain number with two decimals:
 * the amount is still shown, and nothing pretends to know its symbol.
 */
function numberFormat(currency: string | null, locale?: string): Intl.NumberFormat {
  if (currency !== null) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency });
    } catch {
      // not an ISO 4217 code: fall through to the plain number
    }
  }
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
