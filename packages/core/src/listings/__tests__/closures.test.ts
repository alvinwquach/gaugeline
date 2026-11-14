import { describe, expect, it } from "vitest";
import { closuresInText } from "../closures.js";

const TODAY = "2026-11-10";

describe("closures announced in a page's text", () => {
  it("reads a holiday by name: Thanksgiving is the fourth Thursday of November", () => {
    expect(closuresInText("We are closed on Thanksgiving Day. Happy holidays!", TODAY)).toEqual([
      { date: "2026-11-26", label: "Thanksgiving" },
    ]);
  });

  it("reads a written date, with or without a year, either side of the word", () => {
    expect(closuresInText("Closed December 25th for the holiday.", TODAY)).toEqual([
      { date: "2026-12-25", label: "December 25th" },
    ]);
    expect(closuresInText("Dec 24: closed", TODAY)).toEqual([
      { date: "2026-12-24", label: "Dec 24" },
    ]);
    expect(closuresInText("Closed 24 December 2027", TODAY)).toEqual([
      { date: "2027-12-24", label: "24 December 2027" },
    ]);
  });

  it("a date that has passed this year means next year's", () => {
    expect(closuresInText("Closed July 4th", TODAY)).toEqual([
      { date: "2027-07-04", label: "Independence Day" },
    ]);
  });

  it("'closed Mondays, reopening December 1' is not a closure on December 1", () => {
    expect(closuresInText("Closed Mondays, reopening December 1 with a new menu.", TODAY)).toEqual(
      [],
    );
  });

  it("'open Nov 27, closed Nov 28' takes the date next to the word closed", () => {
    expect(closuresInText("Open Nov 27, closed Nov 28", TODAY)).toEqual([
      { date: "2026-11-28", label: "Nov 28" },
    ]);
  });

  it("a date far from the word is not about it", () => {
    expect(
      closuresInText(
        "The kitchen is closed on slow nights and we do not announce which ones in advance. See you on December 3!",
        TODAY,
      ),
    ).toEqual([]);
  });

  it("finds each of several closures once, in date order", () => {
    expect(
      closuresInText("Closed Christmas Eve and Christmas Day. Closed Thanksgiving.", TODAY).map(
        (c) => c.date,
      ),
    ).toEqual(["2026-11-26", "2026-12-24", "2026-12-25"]);
  });
});
