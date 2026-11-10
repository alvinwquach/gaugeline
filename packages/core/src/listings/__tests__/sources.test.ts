import { describe, expect, it } from "vitest";
import { listingsFromAppleCsv } from "../sources/apple.js";
import { parseCsv } from "../sources/csv.js";
import { listingFromBusinessProfile, listingFromPlace } from "../sources/google.js";
import { listingFromYelp } from "../sources/yelp.js";

describe("Google Business Profile", () => {
  const location = {
    title: "Buckhorn Tavern",
    phoneNumbers: { primaryPhone: "(217) 555-0142" },
    storefrontAddress: {
      postalCode: "62999",
      administrativeArea: "IL",
      locality: "Fairmont Heights",
      addressLines: ["412 Alder Street"],
    },
    websiteUri: "https://buckhorn-tavern.example/",
    regularHours: {
      periods: [
        {
          openDay: "FRIDAY",
          openTime: { hours: 11 },
          closeDay: "SATURDAY",
          closeTime: { hours: 2 },
        },
        {
          openDay: "SATURDAY",
          openTime: { hours: 11 },
          closeDay: "SATURDAY",
          closeTime: { hours: 14 },
        },
        {
          openDay: "SATURDAY",
          openTime: { hours: 17 },
          closeDay: "SUNDAY",
          closeTime: { hours: 3 },
        },
      ],
    },
    specialHours: {
      specialHourPeriods: [
        {
          startDate: { year: 2026, month: 12, day: 24 },
          endDate: { year: 2026, month: 12, day: 26 },
          closed: true,
        },
      ],
    },
    openInfo: { status: "OPEN" },
    metadata: { hasVoiceOfMerchant: true, mapsUri: "https://maps.google.example/place/x?cid=1" },
  };

  it("reads name, phone, address, link and hours; a close the next day stays on the day it opens", () => {
    const l = listingFromBusinessProfile(location);
    expect(l).toMatchObject({
      source: "google-business",
      status: "open",
      name: "Buckhorn Tavern",
      phone: "(217) 555-0142",
      address: "412 Alder Street, Fairmont Heights, IL 62999",
      website: "https://buckhorn-tavern.example/",
      url: "https://maps.google.example/place/x",
    });
    expect(l.hours).toEqual({
      fri: [[660, 1560]],
      sat: [
        [660, 840],
        [1020, 1620],
      ],
    });
  });

  it("a range of special days is each date, closed", () => {
    expect(listingFromBusinessProfile(location).specialDays).toEqual([
      { date: "2026-12-24", closed: true },
      { date: "2026-12-25", closed: true },
      { date: "2026-12-26", closed: true },
    ]);
  });

  it("permanently closed, temporarily closed and unverified are statuses", () => {
    expect(listingFromBusinessProfile({ openInfo: { status: "CLOSED_PERMANENTLY" } }).status).toBe(
      "closed-permanently",
    );
    expect(listingFromBusinessProfile({ openInfo: { status: "CLOSED_TEMPORARILY" } }).status).toBe(
      "closed-temporarily",
    );
    expect(
      listingFromBusinessProfile({
        openInfo: { status: "OPEN" },
        metadata: { hasVoiceOfMerchant: false },
      }).status,
    ).toBe("unverified");
  });

  it("a location with no hours has no hours, which is not 'closed every day'", () => {
    expect(listingFromBusinessProfile({ title: "No Hours Bar" }).hours).toBeUndefined();
  });

  it("an answer that is not a location is refused", () => {
    expect(() => listingFromBusinessProfile("nope")).toThrow(/not a location/);
  });
});

describe("Google Maps (Places)", () => {
  it("reads the public fields; day 0 is Sunday", () => {
    const l = listingFromPlace({
      displayName: { text: "The BUCK Tavern" },
      nationalPhoneNumber: "(217) 555-0142",
      formattedAddress: "412 Alder Street, Fairmont Heights, IL 62999, USA",
      websiteUri: "https://bucktavern.example/",
      businessStatus: "OPERATIONAL",
      regularOpeningHours: {
        periods: [
          { open: { day: 0, hour: 12 }, close: { day: 0, hour: 22 } },
          { open: { day: 6, hour: 16 }, close: { day: 0, hour: 2 } },
        ],
      },
    });
    expect(l.name).toBe("The BUCK Tavern");
    expect(l.status).toBe("open");
    expect(l.hours).toEqual({ sun: [[720, 1320]], sat: [[960, 1560]] });
    expect(l.specialDays).toBeUndefined();
  });

  it("a place open around the clock has one period and no close", () => {
    const l = listingFromPlace({
      businessStatus: "OPERATIONAL",
      regularOpeningHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
    });
    expect(Object.keys(l.hours ?? {})).toHaveLength(7);
    expect(l.hours?.wed).toEqual([[0, 1440]]);
  });

  it("business status becomes the listing's status", () => {
    expect(listingFromPlace({ businessStatus: "CLOSED_PERMANENTLY" }).status).toBe(
      "closed-permanently",
    );
  });
});

describe("Yelp", () => {
  it("reads hours with day 0 as Monday and an overnight close as the next morning", () => {
    const l = listingFromYelp({
      name: "The BUCK Tavern",
      display_phone: "(217) 555-0163",
      is_claimed: true,
      is_closed: false,
      url: "https://www.yelp.example/biz/x?adjust_creative=y",
      location: { display_address: ["412 Alder Street", "Fairmont Heights, IL 62999"] },
      hours: [
        {
          hours_type: "REGULAR",
          open: [
            { day: 4, start: "1100", end: "0200" },
            { day: 6, start: "1100", end: "2100" },
          ],
        },
      ],
      special_hours: [
        { date: "2026-11-26", is_closed: true },
        { date: "2026-12-24", is_closed: null, start: "1600", end: "2000" },
      ],
    });
    expect(l.hours).toEqual({ fri: [[660, 1560]], sun: [[660, 1260]] });
    expect(l.address).toBe("412 Alder Street, Fairmont Heights, IL 62999");
    expect(l.url).toBe("https://www.yelp.example/biz/x");
    expect(l.specialDays).toEqual([
      { date: "2026-11-26", closed: true },
      { date: "2026-12-24", closed: false },
    ]);
    expect(l.website).toBeUndefined();
  });

  it("is_closed means closed for good; an unclaimed page is unverified", () => {
    expect(listingFromYelp({ is_closed: true }).status).toBe("closed-permanently");
    expect(listingFromYelp({ is_claimed: false, is_closed: false }).status).toBe("unverified");
  });
});

describe("Apple Business Connect export", () => {
  it("reads one row with an hours column and a status", () => {
    const [l] = listingsFromAppleCsv(
      'Location ID,Business Name,Address Line 1,City,State,ZIP,Phone,Website,Hours,Status\nbt-001,"BUCK Tavern, The",418 Alder Street,Fairmont Heights,IL,62999,(217) 555-0142,https://www.bucktavern.example/,"Mon-Thu 4pm-1am; Fri-Sat 4pm-2am; Sun 12pm-10pm",Verified\n',
    );
    expect(l).toMatchObject({
      source: "apple",
      status: "open",
      name: "BUCK Tavern, The",
      address: "418 Alder Street, Fairmont Heights, IL 62999",
    });
    expect(l?.hours?.fri).toEqual([[960, 1560]]);
    expect(l?.hours?.sun).toEqual([[720, 1320]]);
  });

  it("reads one column per weekday, with closed days", () => {
    const [l] = listingsFromAppleCsv("name,Monday,Tuesday,Sunday\nA,Closed,11:00-02:00,12pm-9pm\n");
    expect(l?.hours).toEqual({ mon: [], tue: [[660, 1560]], sun: [[720, 1260]] });
  });

  it("a status of permanently closed or unverified is read", () => {
    expect(listingsFromAppleCsv("name,status\nA,Permanently closed\n")[0]?.status).toBe(
      "closed-permanently",
    );
    expect(listingsFromAppleCsv("name,status\nA,Unverified\n")[0]?.status).toBe("unverified");
  });

  it("a file with none of the columns it reads, or no rows, is refused with the reason", () => {
    expect(() => listingsFromAppleCsv("colour,size\nred,big\n")).toThrow(/none of the columns/);
    expect(() => listingsFromAppleCsv("name,phone\n")).toThrow(/no rows/);
  });

  it("the CSV reader handles quotes, doubled quotes, line breaks inside quotes and a BOM", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\nlines", "z"],
    ]);
  });
});
