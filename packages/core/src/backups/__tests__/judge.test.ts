import { describe, expect, it } from "vitest";
import { ageInDays, agePhrase, dayOf, exportDateOf, judgeExports, stale } from "../judge.js";
import type { ExportFile } from "../types.js";

const NOW = new Date("2026-11-11T09:00:00Z");

const file = (name: string, size: number, date: string): ExportFile => ({
  name,
  size,
  date,
  dateFrom: "name",
});

describe("age", () => {
  it("counts whole days between the backup and the injected clock", () => {
    expect(ageInDays("2026-11-10T08:00:00Z", NOW)).toBe(1);
    expect(ageInDays("2026-11-11T08:59:00Z", NOW)).toBe(0);
    expect(ageInDays("2026-11-03T09:00:00Z", NOW)).toBe(8);
  });

  it("a backup a little in the future (a clock a bit behind) is today, never negative", () => {
    expect(ageInDays("2026-11-11T10:00:00Z", NOW)).toBe(0);
  });

  it("is stale only past the allowed days, in exact milliseconds", () => {
    expect(stale("2026-11-04T09:00:00Z", NOW, 7)).toBe(false);
    expect(stale("2026-11-04T08:59:59Z", NOW, 7)).toBe(true);
    expect(stale("2026-11-10T09:00:00Z", NOW, 1)).toBe(false);
  });

  it("writes the age in words", () => {
    expect(agePhrase("2026-11-11T07:00:00Z", NOW)).toBe("today (11 Nov 2026)");
    expect(agePhrase("2026-11-10T07:00:00Z", NOW)).toBe("1 day ago (10 Nov 2026)");
    expect(agePhrase("2026-10-30T07:00:00Z", NOW)).toBe("12 days ago (30 Oct 2026)");
  });
});

describe("the day of an export file", () => {
  it.each([
    ["db-2026-11-10.sql.gz", "2026-11-10"],
    ["backup_20261110_0300.dump", "2026-11-10"],
    ["marlowe-bar-2026-11-10T03-00-01Z.json", "2026-11-10"],
    ["2026.11.09-uploads.zip", "2026-11-09"],
  ])("reads %s as %s", (name, day) => {
    expect(exportDateOf(name, "2026-01-01T00:00:00Z")).toEqual({ date: day, dateFrom: "name" });
  });

  it("falls back to when the file was last changed, and says so", () => {
    expect(exportDateOf("latest.sql.gz", "2026-11-08T23:10:00Z")).toEqual({
      date: "2026-11-08",
      dateFrom: "modified",
    });
  });

  it("does not read an impossible date or a long number as a day", () => {
    expect(exportDateOf("db-2026-13-45.sql", "2026-11-08T00:00:00Z").dateFrom).toBe("modified");
    expect(exportDateOf("dump-1731283200000.sql", "2026-11-08T00:00:00Z").dateFrom).toBe(
      "modified",
    );
  });

  it("a day is the UTC day of an ISO time", () => {
    expect(dayOf("2026-11-10T23:59:59-05:00")).toBe("2026-11-11");
  });
});

describe("judgeExports", () => {
  it("an empty folder has no latest export", () => {
    expect(judgeExports([], 50)).toEqual({ kind: "empty" });
  });

  it("one file is the latest with nothing to compare", () => {
    const j = judgeExports([file("a-2026-11-10.sql", 100, "2026-11-10")], 50);
    expect(j).toMatchObject({ kind: "ok", latest: { name: "a-2026-11-10.sql" } });
    expect(j.kind === "ok" && j.previous).toBeUndefined();
    expect(j.kind === "ok" && j.shrunk).toBe(false);
  });

  it("orders by day, newest first, whatever order the files came in", () => {
    const j = judgeExports(
      [file("c", 40, "2026-11-10"), file("a", 100, "2026-11-03"), file("b", 90, "2026-11-07")],
      50,
    );
    expect(j.kind === "ok" && [j.latest.name, j.previous?.name]).toEqual(["c", "b"]);
  });

  it("flags a latest export under the percent of the one before it, in integers", () => {
    const at = (latest: number, previous: number, pct = 50) => {
      const j = judgeExports(
        [file("new", latest, "2026-11-10"), file("old", previous, "2026-11-09")],
        pct,
      );
      return j.kind === "ok" && j.shrunk;
    };
    expect(at(49, 100)).toBe(true);
    expect(at(50, 100)).toBe(false);
    expect(at(0, 100)).toBe(true);
    expect(at(10, 0)).toBe(false);
    expect(at(799, 1000, 80)).toBe(true);
    expect(at(800, 1000, 80)).toBe(false);
  });

  it("two files on one day: the bigger counts, so a re-run does not hide a good export", () => {
    const j = judgeExports(
      [
        file("db-a", 10, "2026-11-10"),
        file("db-b", 90, "2026-11-10"),
        file("db-prev", 100, "2026-11-09"),
      ],
      50,
    );
    expect(j.kind === "ok" && j.latest.name).toBe("db-b");
    expect(j.kind === "ok" && j.shrunk).toBe(false);
  });
});
