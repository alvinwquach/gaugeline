import { describe, expect, it } from "vitest";
import { readListings } from "../read.js";
import { BAR_CONFIG, KEYS, barFetcher, barSettings } from "./helpers.js";

type Seen = { url: URL; headers: Record<string, string> }[];

describe("reading the listings (recorded answers only)", () => {
  it("an invented bar with an old name on Google, different Sunday hours on Yelp and a link to the old domain", async () => {
    const seen: Seen = [];
    const read = await readListings(barSettings(), barFetcher("listings-bucktavern", seen));
    expect(read.notices).toEqual([]);
    expect(read.listings.map((l) => [l.source, l.name])).toEqual([
      ["google-business", "Buckhorn Tavern"],
      ["yelp", "The BUCK Tavern"],
      ["apple", "BUCK Tavern"],
      ["bio-link", undefined],
    ]);
    const yelp = read.listings.find((l) => l.source === "yelp");
    expect(yelp?.hours?.sun).toEqual([[720, 1260]]);
    // Each distinct website link is opened once, and what was found is kept by link.
    expect(read.links.get("https://buckhorn-tavern.example/")).toMatchObject({
      status: 200,
      finalUrl: "https://bucktavern.example/",
      redirects: 1,
    });
    expect(read.links.get("https://links.example/bucktavern")?.linkHosts).toEqual([
      "buckhorn-tavern.example",
      "links.example",
    ]);
  });

  it("every request is a GET; the keys are in headers, never in an address", async () => {
    const seen: Seen = [];
    await readListings(barSettings(), barFetcher("listings-bucktavern", seen));
    const sent = seen.filter((s) => /googleapis|yelp\.com/.test(s.url.hostname));
    expect(sent).toHaveLength(2);
    for (const s of seen) {
      for (const key of Object.values(KEYS)) expect(s.url.href).not.toContain(key);
    }
    const google = sent.find((s) => s.url.hostname.includes("mybusiness"));
    expect(google?.headers.authorization).toBe(`Bearer ${KEYS.GOOGLE_BUSINESS_PROFILE_TOKEN}`);
    // The key goes to the service it belongs to and to no website a listing links to.
    for (const s of seen.filter((x) => !/googleapis|yelp\.com/.test(x.url.hostname)))
      expect(JSON.stringify(s.headers)).not.toMatch(/authorization|x-goog/i);
  });

  it("a missing key for one source: that source is a notice, the others still run", async () => {
    const env = { ...KEYS, YELP_API_KEY: undefined };
    const read = await readListings(barSettings(env), barFetcher("listings-bucktavern"));
    expect(read.notices).toEqual([
      {
        connector: "yelp",
        kind: "not-configured",
        message: "yelp is not set up, so it was left out. Set YELP_API_KEY to include it.",
      },
    ]);
    expect(read.listings.map((l) => l.source)).toEqual(["google-business", "apple", "bio-link"]);
  });

  it("a token Google refuses is a notice that names no key, and the others still run", async () => {
    const read = await readListings(
      barSettings(KEYS, { ...BAR_CONFIG, apple: undefined, bios: undefined, yelp: undefined }),
      barFetcher("listings-limits"),
    );
    expect(read.listings).toEqual([]);
    expect(read.notices).toHaveLength(1);
    expect(read.notices[0]?.kind).toBe("refused");
    expect(JSON.stringify(read)).not.toContain(KEYS.GOOGLE_BUSINESS_PROFILE_TOKEN);
  });

  it("rate limits: Places says when to try again (Retry-After), Yelp says it with its reset time", async () => {
    const read = await readListings(
      barSettings(KEYS, {
        google: { placeId: "ChIJexampleBuckTavern01" },
        yelp: { businessId: "the-buck-tavern-fairmont-heights" },
      }),
      barFetcher("listings-limits"),
    );
    expect(read.listings).toEqual([]);
    expect(read.notices.map((n) => [n.connector, n.kind])).toEqual([
      ["google-places", "unreachable"],
      ["yelp", "unreachable"],
    ]);
    expect(read.notices[0]?.message).toContain("slow down (HTTP 429). Try again in 120 seconds.");
    expect(read.notices[1]?.message).toContain("Try again after 2026-11-11T08:00:00Z.");
  });

  it("Places is read with the key in a header and a field mask, and gives no special hours", async () => {
    const seen: Seen = [];
    const read = await readListings(
      barSettings(KEYS, { google: { placeId: "ChIJexampleBuckTavern01" } }),
      barFetcher("listings-places", seen),
    );
    expect(read.notices).toEqual([]);
    const places = read.listings[0];
    expect(places).toMatchObject({ source: "google-places", name: "The BUCK Tavern" });
    expect(places?.specialDays).toBeUndefined();
    const sent = seen.find((s) => s.url.hostname === "places.googleapis.com");
    expect(sent?.headers["x-goog-api-key"]).toBe(KEYS.GOOGLE_PLACES_API_KEY);
    expect(sent?.headers["x-goog-fieldmask"]).toContain("regularOpeningHours");
    expect(sent?.url.search).toBe("");
  });

  it("a listing that is permanently closed is read as such", async () => {
    const read = await readListings(
      barSettings(KEYS, { yelp: { businessId: "the-buck-tavern-fairmont-heights" } }),
      barFetcher("listings-closed"),
    );
    expect(read.listings[0]?.status).toBe("closed-permanently");
  });

  it("a link that cannot be opened is kept as what went wrong, not thrown", async () => {
    const read = await readListings(
      barSettings(KEYS, { bios: [{ name: "Facebook", url: "https://nobody.example/x" }] }),
      barFetcher("listings-places"),
    );
    expect(read.links.get("https://nobody.example/x")?.error).toBeTypeOf("string");
  });
});
