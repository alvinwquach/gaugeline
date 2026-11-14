import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { DEFAULT_WINDOW, parseWindow } from "../window.js";

const NOW = new Date("2026-11-10T12:00:00Z");

describe("parseWindow: unit", () => {
  it("7d is seven days back from now", () => {
    const w = parseWindow("7d", NOW);
    expect(w.from.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(w.to).toEqual(NOW);
    expect(w.label).toBe("the last 7 days");
  });

  it("24h is a day back, and 1d / 1h are singular", () => {
    expect(parseWindow("24h", NOW).from.toISOString()).toBe("2026-11-09T12:00:00.000Z");
    expect(parseWindow("24h", NOW).label).toBe("the last 24 hours");
    expect(parseWindow("1d", NOW).label).toBe("the last day");
    expect(parseWindow("1h", NOW).label).toBe("the last hour");
  });

  it("an ISO date is midnight UTC that day", () => {
    const w = parseWindow("2026-11-01", NOW);
    expect(w.from.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(w.label).toBe("since 2026-11-01");
  });

  it("an ISO date and time with an offset is that instant", () => {
    expect(parseWindow("2026-11-09T08:00:00-08:00", NOW).from.toISOString()).toBe(
      "2026-11-09T16:00:00.000Z",
    );
  });

  it("no value is the default, seven days", () => {
    expect(DEFAULT_WINDOW).toBe("7d");
    expect(parseWindow(undefined, NOW).label).toBe("the last 7 days");
  });

  it("the upper and lower case of the unit does not matter", () => {
    expect(parseWindow("7D", NOW).from).toEqual(parseWindow("7d", NOW).from);
  });

  it.each(["", "soon", "7", "d7", "0d", "-3d", "1.5d", "7 days", "2026-13-01", "2026-02-30", "7w"])(
    "garbage %j is refused with a sentence that gives an example",
    (text) => {
      expect(() => parseWindow(text, NOW)).toThrow(ConfigError);
      expect(() => parseWindow(text, NOW)).toThrow(/7d/);
    },
  );

  it("a date in the future is refused", () => {
    expect(() => parseWindow("2026-12-01", NOW)).toThrow(/future/);
  });

  it("more than a year back is refused", () => {
    expect(() => parseWindow("400d", NOW)).toThrow(/366/);
    expect(parseWindow("366d", NOW).from.getTime()).toBeLessThan(NOW.getTime());
    expect(() => parseWindow("2020-01-01", NOW)).toThrow(/366/);
  });
});
