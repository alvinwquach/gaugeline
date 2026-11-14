import { describe, expect, it } from "vitest";
import { ConnectorRateLimitedError, describeRetry } from "../../connectors/http.js";
import { listingsConfigSchema } from "../config.js";

describe("gaugeline.listings.json", () => {
  const ok = (v: unknown) => listingsConfigSchema.safeParse(v);

  it("accepts the sources it reads and nothing that holds a key", () => {
    expect(
      ok({
        timeZone: "America/Chicago",
        google: { location: "locations/1234567890", placeId: "ChIJexampleBuckTavern01" },
        yelp: { businessId: "the-buck-tavern-fairmont-heights" },
        apple: { csv: "apple.csv", location: "bt-001" },
        bios: [{ name: "Instagram", url: "https://links.example/bucktavern" }],
      }).success,
    ).toBe(true);
    expect(ok({ yelp: { businessId: "x1", apiKey: "nope" } }).success).toBe(false);
    expect(ok({ google: { token: "nope", location: "locations/1" } }).success).toBe(false);
  });

  it("must name at least one listing", () => {
    expect(ok({}).success).toBe(false);
    expect(ok({ timeZone: "America/Chicago" }).success).toBe(false);
  });

  it("refuses a time zone Intl does not know", () => {
    const r = ok({ timeZone: "Mars/Olympus", yelp: { businessId: "bar-one" } });
    expect(r.success).toBe(false);
  });

  it("a bio must be a link-in-bio address, never the social platform's own page", () => {
    for (const url of [
      "https://www.instagram.com/bucktavern/",
      "https://facebook.com/bucktavern",
      "https://m.facebook.com/bucktavern",
      "https://tiktok.com/@bucktavern",
    ]) {
      const r = ok({ bios: [{ name: "Social", url }] });
      expect(r.success, url).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("never requests");
    }
    expect(ok({ bios: [{ name: "Linktree", url: "https://linktr.ee/bucktavern" }] }).success).toBe(
      true,
    );
  });

  it("a Business Profile location must look like locations/<digits>", () => {
    expect(ok({ google: { location: "accounts/1/locations/2" } }).success).toBe(false);
  });
});

describe("when a service says to slow down", () => {
  it("reads Retry-After as seconds or as a date, and Yelp's reset time", () => {
    expect(describeRetry({ "retry-after": "120" })).toBe("in 120 seconds");
    expect(describeRetry({ "retry-after": "1" })).toBe("in 1 second");
    expect(describeRetry({ "retry-after": "Wed, 11 Nov 2026 08:00:00 GMT" })).toBe(
      "after 2026-11-11T08:00:00Z",
    );
    expect(describeRetry({ "ratelimit-resettime": "2026-11-11T08:00:00+00:00" })).toBe(
      "after 2026-11-11T08:00:00Z",
    );
    expect(describeRetry({})).toBeUndefined();
    expect(describeRetry({ "retry-after": "soon" })).toBeUndefined();
  });

  it("an answer with no time says so rather than inventing one", () => {
    expect(new ConnectorRateLimitedError(undefined).message).toContain("did not say when");
  });
});
