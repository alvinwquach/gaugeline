import { describe, expect, it } from "vitest";
import {
  DEFAULT_MULTIPLE,
  DEFAULT_WINDOW,
  type Metric,
  dayBefore,
  detectJumps,
  formatQuantity,
  utcDay,
  windowDays,
} from "../usage.js";

const NOW = new Date("2026-11-11T09:00:00Z");

/** A metric from whole units per day: stored as thousandths, which are integers. */
function metric(name: string, unit: string, perDay: Record<string, number>): Metric {
  return {
    name,
    unit,
    daily: new Map(Object.entries(perDay).map(([d, v]) => [d, Math.round(v * 1000)])),
  };
}

/** `n` days ending on `last`, each with `value`. */
function flat(last: string, n: number, value: number): Record<string, number> {
  const out: Record<string, number> = {};
  let day = last;
  for (let i = 0; i < n; i++) {
    out[day] = value;
    day = dayBefore(day);
  }
  return out;
}

describe("UTC days from an injected clock", () => {
  it("utcDay is the UTC calendar day, whatever the machine's zone", () => {
    expect(utcDay(new Date("2026-11-11T23:59:59Z"))).toBe("2026-11-11");
    expect(utcDay(new Date("2026-11-12T00:00:00Z"))).toBe("2026-11-12");
  });

  it("dayBefore crosses a month, a year and a leap day", () => {
    expect(dayBefore("2026-12-01")).toBe("2026-11-30");
    expect(dayBefore("2027-01-01")).toBe("2026-12-31");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
    expect(dayBefore("2027-03-01")).toBe("2027-02-28");
  });

  it("windowDays lists the days before the latest one, newest first", () => {
    expect(windowDays("2026-11-10", 3)).toEqual(["2026-11-09", "2026-11-08", "2026-11-07"]);
    expect(windowDays("2028-03-02", 3)).toEqual(["2028-03-01", "2028-02-29", "2028-02-28"]);
  });
});

describe("detectJumps: the trailing average and the multiple", () => {
  const history = (latest: number, avg: number) =>
    metric("Fast Data Transfer", "GB", { "2026-11-10": latest, ...flat("2026-11-09", 14, avg) });

  it("flags a day more than the multiple of the average of the days before it", () => {
    const [jump, ...rest] = detectJumps([history(41, 12)], NOW, {});
    expect(rest).toEqual([]);
    expect(jump).toMatchObject({
      metric: "Fast Data Transfer",
      unit: "GB",
      day: "2026-11-10",
      latest: 41_000,
      average: 12_000,
      window: 14,
      multiple: DEFAULT_MULTIPLE,
      ratioTenths: 34,
    });
  });

  it("defaults: two times, fourteen days", () => {
    expect(DEFAULT_MULTIPLE).toBe(2);
    expect(DEFAULT_WINDOW).toBe(14);
  });

  it("exactly the multiple is not a jump; one thousandth over is", () => {
    expect(detectJumps([history(24, 12)], NOW, {})).toEqual([]);
    expect(detectJumps([history(24.001, 12)], NOW, {})).toHaveLength(1);
  });

  it("a fall is not a jump", () => {
    expect(detectJumps([history(2, 12)], NOW, {})).toEqual([]);
  });

  it("a steady week is nothing", () => {
    expect(detectJumps([history(12, 12)], NOW, {})).toEqual([]);
  });

  it("uses the configured multiple and window", () => {
    expect(detectJumps([history(20, 12)], NOW, { multiple: 1.5 })).toHaveLength(1);
    expect(detectJumps([history(20, 12)], NOW, { multiple: 1.7 })).toEqual([]);
    const short = metric("Requests", "Number", {
      "2026-11-10": 90,
      "2026-11-09": 100,
      "2026-11-08": 100,
      "2026-11-07": 100,
      "2026-11-06": 1000,
    });
    expect(detectJumps([short], NOW, { window: 3 })).toEqual([]);
  });

  it("the average is over the window, so a day with no rows counts as zero", () => {
    const m = metric("Requests", "Number", {
      "2026-11-10": 100,
      "2026-11-09": 70,
      "2026-11-08": 70,
    });
    // trailing 4 days: 70 + 70 + 0 + 0 = 140, average 35: 100 is 2.8 times
    expect(detectJumps([m], NOW, { window: 4 })[0]?.average).toBe(35_000);
  });

  it("with no usage in the days before there is nothing to be a multiple of", () => {
    expect(detectJumps([metric("Requests", "Number", { "2026-11-10": 500 })], NOW, {})).toEqual([]);
  });

  it("ignores a day under one whole unit, which is noise", () => {
    expect(detectJumps([history(0.9, 0.1)], NOW, {})).toEqual([]);
  });

  it("never reads today: it is not over, so its total is partial", () => {
    const m = metric("Requests", "Number", { "2026-11-11": 99_999, ...flat("2026-11-10", 15, 10) });
    expect(detectJumps([m], NOW, {})).toEqual([]);
  });

  it("the latest day is yesterday in UTC, at 00:00:01 and at 23:59:59", () => {
    const m = metric("Requests", "Number", { "2026-11-10": 100, ...flat("2026-11-09", 14, 10) });
    expect(detectJumps([m], new Date("2026-11-11T00:00:01Z"), {})).toHaveLength(1);
    expect(detectJumps([m], new Date("2026-11-11T23:59:59Z"), {})).toHaveLength(1);
    expect(detectJumps([m], new Date("2026-11-12T00:00:00Z"), {})).toEqual([]);
  });

  it("is exact for very large figures (bytes of a busy month)", () => {
    const big = metric("Bandwidth", "Bytes", {
      "2026-11-10": 9_000_000_000_000,
      ...flat("2026-11-09", 14, 4_000_000_000_000),
    });
    expect(detectJumps([big], NOW, {})).toHaveLength(1);
  });

  it("orders jumps by how far they jumped, then by name, and is deterministic", () => {
    const a = metric("Edge Requests", "Number", {
      "2026-11-10": 300,
      ...flat("2026-11-09", 14, 100),
    });
    const b = metric("Function Duration", "Hours", {
      "2026-11-10": 500,
      ...flat("2026-11-09", 14, 100),
    });
    const c = metric("Image Optimization", "Number", {
      "2026-11-10": 300,
      ...flat("2026-11-09", 14, 100),
    });
    const names = detectJumps([a, b, c], NOW, {}).map((j) => j.metric);
    expect(names).toEqual(["Function Duration", "Edge Requests", "Image Optimization"]);
    expect(detectJumps([c, b, a], NOW, {}).map((j) => j.metric)).toEqual(names);
  });
});

describe("formatQuantity", () => {
  it.each([
    [41_000, "GB", "41 GB"],
    [12_500, "GB", "12.5 GB"],
    [1_234_567_000, "Number", "1,234,567"],
    [380, "USD", "0.4 USD"],
    [138_000, "USD", "138 USD"],
    [0, "GB", "0 GB"],
  ])("%i thousandths of %s is %s", (milli, unit, text) => {
    expect(formatQuantity(milli, unit)).toBe(text);
  });
});
