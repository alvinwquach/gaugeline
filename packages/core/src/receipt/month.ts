/** A calendar month in UTC: "2026-10" is 1 October 00:00 up to, not including, 1 November 00:00. */
export interface ReceiptMonth {
  month: string;
  /** ISO time of the first moment of the month. */
  from: string;
  /** ISO time of the first moment of the next month. */
  to: string;
}

/** yyyy-mm, or undefined. Months are UTC so the same month gives the same receipt on every machine. */
export function parseReceiptMonth(text: string): ReceiptMonth | undefined {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text);
  if (!m) return undefined;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return {
    month: text,
    from: new Date(Date.UTC(year, index, 1)).toISOString(),
    to: new Date(Date.UTC(year, index + 1, 1)).toISOString(),
  };
}

const NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "October 2026". */
export function monthName(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${NAMES[Number(m[2]) - 1] ?? month} ${m[1]}` : month;
}

/** The month before the one `now` is in, as yyyy-mm (UTC). */
export function previousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
