import { describe, expect, it } from "vitest";
import {
  describeRange,
  fixedVersion,
  inRange,
  parseRange,
  parseVersion,
  rangeFromEvents,
  type Family,
} from "../range.js";

const hit = (family: Family, range: string, version: string): boolean | undefined => {
  const set = parseRange(family, range);
  if (!set) throw new Error(`range not read: ${range}`);
  return inRange(family, version, set);
};

describe("versions: npm (semantic versioning)", () => {
  it("reads three numbers, a pre-release and ignores build metadata", () => {
    expect(parseVersion("npm", "16.2.1")?.nums).toEqual([16, 2, 1, 0]);
    expect(parseVersion("npm", "v15.0.0-canary.12+abc")?.pre).toBe("canary.12");
    expect(parseVersion("npm", "15")).toBeUndefined();
    expect(parseVersion("npm", "not a version")).toBeUndefined();
  });

  it("matches the spec's example range: next@>=15.0.0 <15.2.3", () => {
    const r = ">=15.0.0 <15.2.3";
    expect(hit("npm", r, "15.0.0")).toBe(true);
    expect(hit("npm", r, "15.2.2")).toBe(true);
    expect(hit("npm", r, "15.2.3")).toBe(false);
    expect(hit("npm", r, "14.2.30")).toBe(false);
    expect(hit("npm", r, "16.2.1")).toBe(false);
  });

  it("compares numbers as numbers: 15.10.0 is after 15.9.0", () => {
    expect(hit("npm", "<15.9.0", "15.10.0")).toBe(false);
    expect(hit("npm", ">=15.9.0", "15.10.0")).toBe(true);
  });

  it("puts a pre-release before its release", () => {
    expect(hit("npm", "<15.2.3", "15.2.3-rc.1")).toBe(true);
    expect(hit("npm", "<15.2.3", "15.2.3")).toBe(false);
    expect(hit("npm", "<1.0.0-rc.10", "1.0.0-rc.2")).toBe(true);
  });

  it("reads caret, tilde, x-ranges, hyphen ranges, || and *", () => {
    expect(hit("npm", "^1.2.3", "1.9.0")).toBe(true);
    expect(hit("npm", "^1.2.3", "2.0.0")).toBe(false);
    expect(hit("npm", "^0.2.3", "0.2.9")).toBe(true);
    expect(hit("npm", "^0.2.3", "0.3.0")).toBe(false);
    expect(hit("npm", "~1.2.3", "1.2.9")).toBe(true);
    expect(hit("npm", "~1.2", "1.3.0")).toBe(false);
    expect(hit("npm", "1.2.x", "1.2.40")).toBe(true);
    expect(hit("npm", "1.x", "2.0.0")).toBe(false);
    expect(hit("npm", "1.0.0 - 1.5.0", "1.5.0")).toBe(true);
    expect(hit("npm", "<1.0.0 || >=2.0.0 <2.1.0", "2.0.5")).toBe(true);
    expect(hit("npm", "<1.0.0 || >=2.0.0 <2.1.0", "1.5.0")).toBe(false);
    expect(hit("npm", "*", "0.0.1")).toBe(true);
    expect(hit("npm", "1.2.3", "1.2.3")).toBe(true);
    expect(hit("npm", "=1.2.3", "1.2.4")).toBe(false);
  });

  it("gives no answer for a version that is not a version, and no range for nonsense", () => {
    const set = parseRange("npm", "<1.0.0");
    expect(set && inRange("npm", "latest", set)).toBeUndefined();
    expect(parseRange("npm", "")).toBeUndefined();
    expect(parseRange("npm", "<<1")).toBeUndefined();
    expect(parseRange("npm", "banana")).toBeUndefined();
  });
});

describe("versions: PHP (composer)", () => {
  it("reads a leading v, four numbers and stability words", () => {
    expect(parseVersion("composer", "v10.48.4")?.nums).toEqual([10, 48, 4, 0]);
    expect(parseVersion("composer", "1.2.3.4")?.nums).toEqual([1, 2, 3, 4]);
    expect(parseVersion("composer", "2.0.0-RC1")?.pre).toBe("RC1");
    expect(parseVersion("composer", "dev-main")).toBeUndefined();
  });

  it("takes a comma or a space as 'and' and || or | as 'or'", () => {
    expect(hit("composer", ">=10.0,<10.48.4", "10.30.0")).toBe(true);
    expect(hit("composer", ">=10.0,<10.48.4", "10.48.4")).toBe(false);
    expect(hit("composer", ">=1.0 <1.5 || >=2.0 <2.3", "2.1.0")).toBe(true);
    expect(hit("composer", ">=1.0 <1.5 | >=2.0 <2.3", "1.7.0")).toBe(false);
  });

  it("reads the composer wildcard, tilde and caret", () => {
    expect(hit("composer", "1.2.*", "1.2.9")).toBe(true);
    expect(hit("composer", "1.2.*", "1.3.0")).toBe(false);
    // composer's ~1.2 is >=1.2 <2.0 (npm's is <1.3.0); ~1.2.3 is >=1.2.3 <1.3.0
    expect(hit("composer", "~1.2", "1.9.0")).toBe(true);
    expect(hit("composer", "~1.2.3", "1.3.0")).toBe(false);
    expect(hit("composer", "^1.2.3", "1.9.9")).toBe(true);
  });

  it("orders stability: dev < alpha < beta < RC < stable < patch", () => {
    const order = ["1.0.0-dev", "1.0.0-alpha1", "1.0.0-beta2", "1.0.0-RC1", "1.0.0", "1.0.0-p1"];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(hit("composer", `<${order[i + 1]}`, order[i] ?? "")).toBe(true);
      expect(hit("composer", `<${order[i]}`, order[i + 1] ?? "")).toBe(false);
    }
  });

  it("a fourth number counts: 1.2.3.1 is after 1.2.3", () => {
    expect(hit("composer", "<=1.2.3", "1.2.3.1")).toBe(false);
  });
});

describe("versions: WordPress plugins", () => {
  it("reads one to four numbers and a suffix, padded", () => {
    expect(parseVersion("wordpress", "2.0")?.nums).toEqual([2, 0, 0, 0]);
    expect(parseVersion("wordpress", "1.0.5-beta")?.pre).toBe("beta");
    expect(parseVersion("wordpress", "3.4.5.6")?.nums).toEqual([3, 4, 5, 6]);
    expect(parseVersion("wordpress", "7")?.nums).toEqual([7, 0, 0, 0]);
  });

  it("matches a plugin range the way an advisory writes it", () => {
    expect(hit("wordpress", "<= 2.1.3", "2.1.3")).toBe(true);
    expect(hit("wordpress", "<= 2.1.3", "2.1.4")).toBe(false);
    expect(hit("wordpress", "< 5.8.4", "5.8")).toBe(true);
    expect(hit("wordpress", "<5.8.4", "5.10")).toBe(false);
    expect(hit("wordpress", "<2.4.0", "2.10.1")).toBe(false);
  });
});

describe("OSV events", () => {
  it("introduced 0 and a fixed version is 'below the fix'", () => {
    const set = rangeFromEvents("npm", [{ introduced: "0" }, { fixed: "15.2.3" }]);
    expect(set && inRange("npm", "14.0.0", set)).toBe(true);
    expect(set && inRange("npm", "15.2.3", set)).toBe(false);
  });

  it("several introduced and fixed pairs are several stretches", () => {
    const set = rangeFromEvents("npm", [
      { introduced: "13.0.0" },
      { fixed: "13.5.1" },
      { introduced: "14.0.0" },
      { fixed: "14.2.0" },
    ]);
    expect(set && inRange("npm", "13.9.0", set)).toBe(false);
    expect(set && inRange("npm", "14.1.0", set)).toBe(true);
    expect(set && inRange("npm", "13.2.0", set)).toBe(true);
  });

  it("last_affected includes that version; a stretch with no end runs on", () => {
    const set = rangeFromEvents("composer", [{ introduced: "1.0" }, { last_affected: "1.4.2" }]);
    expect(set && inRange("composer", "1.4.2", set)).toBe(true);
    expect(set && inRange("composer", "1.4.3", set)).toBe(false);
    const open = rangeFromEvents("npm", [{ introduced: "2.0.0" }]);
    expect(open && inRange("npm", "9.9.9", open)).toBe(true);
    expect(open && inRange("npm", "1.9.9", open)).toBe(false);
  });

  it("an event that is not a version gives no range, never a guess", () => {
    expect(rangeFromEvents("npm", [{ introduced: "0" }, { fixed: "banana" }])).toBeUndefined();
    expect(rangeFromEvents("npm", [])).toBeUndefined();
  });
});

describe("the fix and the words", () => {
  it("names the version that ends the stretch the version is in", () => {
    const set = parseRange("npm", ">=14.0.0 <14.2.0 || >=15.0.0 <15.2.3");
    expect(set && fixedVersion("npm", "15.1.0", set)).toBe("15.2.3");
    expect(set && fixedVersion("npm", "14.1.0", set)).toBe("14.2.0");
    expect(set && fixedVersion("npm", "16.0.0", set)).toBeUndefined();
  });

  it("writes a range back as words", () => {
    const set = parseRange("npm", ">=15.0.0 <15.2.3 || ^16.0.0");
    expect(set && describeRange(set)).toBe(">=15.0.0 <15.2.3 || >=16.0.0 <17.0.0");
  });
});
