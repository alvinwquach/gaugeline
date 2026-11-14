import { describe, expect, it } from "vitest";
import type { AssertionResult, AssertionsRead } from "../../assertions/index.js";
import type { CheckContext } from "../../model.js";
import { dataAssertionFailed } from "../data-assertion-failed.js";
import { URL0, page } from "./helpers.js";

const result = (over: Partial<AssertionResult>): AssertionResult => ({
  id: "no-overlapping-bookings",
  title: "Two private events are booked at the same time",
  severity: "high",
  source: "db",
  status: "passed",
  count: 0,
  atLeast: false,
  columns: [],
  rows: [],
  ...over,
});

function run(results: AssertionResult[] | undefined) {
  const notes: Array<{ url: string; reason: string }> = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    ...(results
      ? { assertions: (): Promise<AssertionsRead> => Promise.resolve({ results, notices: [] }) }
      : {}),
  };
  return { notes, found: Promise.resolve(dataAssertionFailed.run(page(), ctx)) };
}

describe("data-assertion-failed", () => {
  it("finds nothing when no assertion is configured", async () => {
    const r = run(undefined);
    expect(await r.found).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it("passes when every assertion returned no rows", async () => {
    const r = run([result({}), result({ id: "no-orphaned-orders" })]);
    expect(await r.found).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it("makes one finding per failed assertion, with the assertion's own severity, title and evidence", async () => {
    const r = run([
      result({
        status: "failed",
        count: 2,
        columns: ["booking_id", "starts_at"],
        rows: [
          { booking_id: "41", starts_at: "2026-12-05T19:00:00.000Z" },
          { booking_id: "42", starts_at: "2026-12-05T20:00:00.000Z" },
        ],
      }),
      result({ id: "no-orphaned-orders" }),
      result({
        id: "no-expired-holds",
        title: "Table holds are still open after they expired",
        severity: "low",
        status: "failed",
        count: 1,
        columns: ["hold_id"],
        rows: [{ hold_id: "9" }],
      }),
    ]);
    expect(await r.found).toEqual([
      {
        checkId: "data-assertion-failed",
        severity: "high",
        title: "Two private events are booked at the same time",
        evidence:
          "no-overlapping-bookings: 2 rows. booking_id=41, starts_at=2026-12-05T19:00:00.000Z; booking_id=42, starts_at=2026-12-05T20:00:00.000Z",
        url: URL0,
      },
      {
        checkId: "data-assertion-failed",
        severity: "low",
        title: "Table holds are still open after they expired",
        evidence: "no-expired-holds: 1 row. hold_id=9",
        url: URL0,
      },
    ]);
  });

  it("lists an assertion that could not run as could-not-check, never as a pass and never as a finding", async () => {
    const r = run([
      result({
        status: "could-not-check",
        message: 'The assertion "no-overlapping-bookings" took longer than the statement timeout.',
      }),
      result({
        id: "bad-column",
        status: "config-error",
        message: 'assertion "bad-column" lists the evidence column "nope".',
      }),
    ]);
    expect(await r.found).toEqual([]);
    expect(r.notes).toEqual([
      {
        url: URL0,
        reason: 'The assertion "no-overlapping-bookings" took longer than the statement timeout.',
      },
      { url: URL0, reason: 'assertion "bad-column" lists the evidence column "nope".' },
    ]);
  });

  it("has the text the checks reference prints", () => {
    expect(dataAssertionFailed.id).toBe("data-assertion-failed");
    for (const field of ["what", "why", "fix", "tech"] as const)
      expect(dataAssertionFailed[field].length).toBeGreaterThan(40);
  });
});
