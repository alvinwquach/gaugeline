import { describe, expect, it } from "vitest";
import { CELL_CHARS, EVIDENCE_ROWS, cellText, describeAssertion } from "../evidence.js";
import type { AssertionResult } from "../types.js";

const failed = (over: Partial<AssertionResult> = {}): AssertionResult => ({
  id: "no-overlapping-bookings",
  title: "Two private events are booked at the same time",
  severity: "high",
  source: "db",
  status: "failed",
  count: 2,
  atLeast: false,
  columns: ["booking_id", "starts_at"],
  rows: [
    { booking_id: "41", starts_at: "2026-12-05T19:00:00.000Z" },
    { booking_id: "42", starts_at: "2026-12-05T20:00:00.000Z" },
  ],
  ...over,
});

describe("one cell of evidence", () => {
  const same = (x: string): string => x;
  it("shows plain values as they are and marks the empty ones", () => {
    expect(cellText(41, same)).toBe("41");
    expect(cellText(true, same)).toBe("true");
    expect(cellText(null, same)).toBe("null");
    expect(cellText("2026-12-05T19:00:00.000Z", same)).toBe("2026-12-05T19:00:00.000Z");
  });

  it("quotes text that has spaces, commas, semicolons, equals signs or quotes", () => {
    expect(cellText("Okafor party", same)).toBe('"Okafor party"');
    expect(cellText("a,b", same)).toBe('"a,b"');
    expect(cellText("a;b", same)).toBe('"a;b"');
    expect(cellText("a=b", same)).toBe('"a=b"');
    expect(cellText('say "hi"', same)).toBe('"say \\"hi\\""');
    expect(cellText("", same)).toBe('""');
  });

  it("escapes control, invisible and tag characters and flattens line breaks", () => {
    expect(cellText("a\u200Bb", same)).toBe("a\\u{200B}b");
    expect(cellText("x\u0007y", same)).toBe("x\\u{7}y");
    expect(cellText("line one\nline two", same)).toBe('"line one line two"');
    expect(cellText("\u{E0041}", same)).toBe("\\u{E0041}");
  });

  it("cuts long text at the cell limit", () => {
    expect(CELL_CHARS).toBe(80);
    const shown = cellText("x".repeat(500), same);
    expect([...shown]).toHaveLength(CELL_CHARS + 1);
    expect(shown.endsWith("\u2026")).toBe(true);
  });

  it("passes the text through the redactor after cutting it", () => {
    const redact = (t: string): string => t.replace("hunter2-secret", "[redacted]");
    expect(cellText("hunter2-secret", redact)).toBe("[redacted]");
  });
});

describe("the evidence line", () => {
  it("starts with the assertion, says how many rows and lists the evidence columns of each", () => {
    expect(describeAssertion(failed())).toBe(
      "no-overlapping-bookings: 2 rows. booking_id=41, starts_at=2026-12-05T19:00:00.000Z; booking_id=42, starts_at=2026-12-05T20:00:00.000Z",
    );
  });

  it("says 1 row for one row", () => {
    expect(
      describeAssertion(failed({ count: 1, rows: [{ booking_id: "41", starts_at: "x" }] })),
    ).toContain(": 1 row. ");
  });

  it("says how many there were when only the first rows are shown", () => {
    expect(EVIDENCE_ROWS).toBe(20);
    const rows = Array.from({ length: 20 }, (_, i) => ({ booking_id: String(i), starts_at: "t" }));
    const line = describeAssertion(failed({ count: 50, rows }));
    expect(line).toContain("50 rows, showing the first 20.");
    expect(line.split("; ")).toHaveLength(20);
  });

  it("says more than the cap when the query was cut", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ booking_id: String(i), starts_at: "t" }));
    const line = describeAssertion(failed({ count: 5000, atLeast: true, rows }));
    expect(line).toContain(": more than 5,000 rows, showing the first 20.");
  });

  it("describes an assertion that could not be checked or is misconfigured by its message", () => {
    expect(
      describeAssertion({
        id: "x-y",
        title: "t",
        severity: "low",
        source: "db",
        status: "could-not-check",
        count: 0,
        atLeast: false,
        columns: [],
        rows: [],
        message: "The assertion took too long.",
      }),
    ).toBe("x-y: The assertion took too long.");
  });
});
