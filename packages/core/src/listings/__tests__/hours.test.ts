import { describe, expect, it } from "vitest";
import {
  compareHours,
  describeDay,
  describeHours,
  mergeIntervals,
  parseListedHours,
  type DayHours,
} from "../hours.js";

const h = (text: string): DayHours => parseListedHours(text);

describe("hours normalisation", () => {
  it("reads 11am-2am as a day that closes after midnight, kept on the day it opens", () => {
    expect(h("Fri 11am-2am")).toEqual({ fri: [[660, 1560]] });
  });

  it("reads 11:00-02:00 with an en dash the same way", () => {
    expect(h("Fri 11:00\u201302:00")).toEqual(h("Fri 11am-2am"));
  });

  it("reads a split shift written with a comma, an ampersand or 'and'", () => {
    const want: DayHours = {
      tue: [
        [660, 840],
        [1020, 1320],
      ],
    };
    expect(h("Tue 11am-2pm, 5pm-10pm")).toEqual(want);
    expect(h("Tue 11am-2pm & 5pm-10pm")).toEqual(want);
    expect(h("Tue 11:00-14:00 and 17:00-22:00")).toEqual(want);
  });

  it("reads closed days, day ranges and several segments", () => {
    expect(h("Mon closed; Tue-Thu 4pm-11pm; Fri-Sat 4pm-2am; Sun 12pm-9pm")).toEqual({
      mon: [],
      tue: [[960, 1380]],
      wed: [[960, 1380]],
      thu: [[960, 1380]],
      fri: [[960, 1560]],
      sat: [[960, 1560]],
      sun: [[720, 1260]],
    });
  });

  it("reads noon and midnight, and a close of midnight as the end of that day", () => {
    expect(h("Sat noon-midnight")).toEqual({ sat: [[720, 1440]] });
  });

  it("leaves out a day given two different answers, and anything it cannot read", () => {
    expect(h("Mon 11am-2pm; Mon 5pm-10pm; Tue 9-5")).toEqual({});
    expect(h("whenever we feel like it")).toEqual({});
  });

  it("an equal open and close is not guessed", () => {
    expect(h("Sun 12am-12am")).toEqual({});
  });

  it("merges touching and overlapping intervals so one shift is one shift", () => {
    expect(
      mergeIntervals([
        [840, 1560],
        [660, 840],
      ]),
    ).toEqual([[660, 1560]]);
  });

  it("describes a day the way a person writes it", () => {
    expect(describeDay([[660, 1560]])).toBe("11am-2am");
    expect(describeDay([])).toBe("closed");
    expect(
      describeDay([
        [690, 840],
        [1020, 1440],
      ]),
    ).toBe("11:30am-2pm, 5pm-midnight");
  });
});

describe("hours comparison", () => {
  it("only compares the days the site states", () => {
    const site = h("Fri 11am-2am");
    const listing = h("Mon closed; Fri 11am-2am; Sat 11am-3am");
    expect(compareHours(site, listing)).toEqual([]);
  });

  it("names each day that differs, with both sides", () => {
    const site = h("Fri-Sat 11am-2am; Sun 12pm-9pm");
    const listing = h("Fri 11am-2am; Sat 11am-3am; Sun closed");
    expect(compareHours(site, listing)).toEqual([
      { day: "sat", site: [[660, 1560]], listing: [[660, 1620]] },
      { day: "sun", site: [[720, 1260]], listing: [] },
    ]);
    expect(describeHours(compareHours(site, listing), "Yelp")).toBe(
      "Saturday: Yelp says 11am-3am, your site says 11am-2am; Sunday: Yelp says closed, your site says noon-9pm",
    );
  });

  it("a listing day with no entry is closed when the listing gave hours at all", () => {
    expect(compareHours(h("Mon 11am-5pm"), { tue: [[600, 700]] })).toEqual([
      { day: "mon", site: [[660, 1020]], listing: [] },
    ]);
  });

  it("11am-2am and 11:00-02:00 are the same hours; a split shift written as one range is not", () => {
    expect(compareHours(h("Fri 11am-2am"), h("Fri 11:00-02:00"))).toEqual([]);
    expect(compareHours(h("Fri 11am-2pm, 5pm-2am"), h("Fri 11am-2am"))).toHaveLength(1);
  });
});
