import { observedEvents, type EventsRead } from "@gaugeline/core";

/**
 * The observed events as CSV, a starting tracking plan: one row per element clicked. This is the
 * formatter for `gaugeline events export`; the command itself arrives with rendered reads (G39),
 * because until then nothing can be clicked.
 */
export const EVENTS_CSV_COLUMNS = [
  "element",
  "text",
  "destination",
  "parent_menu",
  "expected_event",
  "result",
  "sent",
] as const;

/** RFC 4180 quoting, and a leading ' on anything a spreadsheet would run as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function eventsCsv(read: EventsRead): string {
  const rows = observedEvents(read).map(({ target, rule, verdict }) => [
    target.path,
    target.text,
    target.destination ?? "",
    target.parent ?? "",
    rule.event,
    verdict.state,
    "sent" in verdict ? JSON.stringify(verdict.sent) : "",
  ]);
  return (
    [[...EVENTS_CSV_COLUMNS], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"
  );
}
