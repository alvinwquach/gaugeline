import { describe, expect, it } from "vitest";
import { addressesAgree, namesAgree, normaliseName, sameHost, websiteProblem } from "../match.js";

describe("name normalisation", () => {
  it("'The BUCK Tavern' and 'Buck Tavern, The' are one name", () => {
    expect(normaliseName("The BUCK Tavern")).toBe("buck tavern");
    expect(normaliseName("Buck Tavern, The")).toBe("buck tavern");
    expect(namesAgree("The BUCK Tavern", "Buck Tavern, The")).toBe(true);
  });

  it("ignores case, accents, punctuation and ampersands", () => {
    expect(namesAgree("Caf\u00E9 Rosa & Sons", "CAFE ROSA AND SONS!")).toBe(true);
  });

  it("a listing that adds a place after the name still agrees", () => {
    expect(namesAgree("The BUCK Tavern", "BUCK Tavern - Eastside")).toBe(true);
  });

  it("an old name is a different name, even when it starts the same way", () => {
    expect(namesAgree("The BUCK Tavern", "Buckhorn Tavern")).toBe(false);
    expect(namesAgree("The BUCK Tavern", "Buckhorn")).toBe(false);
  });

  it("one word is not matched inside a longer name", () => {
    expect(namesAgree("Tavern", "The Old Tavern on Main")).toBe(false);
  });
});

describe("address agreement", () => {
  it("compares the street number and the ZIP code, and nothing else", () => {
    expect(addressesAgree("412 Alder St, Springfield, IL 62704", "412 Alder Street, 62704")).toBe(
      true,
    );
    expect(addressesAgree("412 Alder St, Springfield, IL 62704", "418 Alder St, 62704")).toBe(
      false,
    );
    expect(addressesAgree("412 Alder St, 62704", "412 Alder St, 62711")).toBe(false);
  });

  it("is undefined when either side has nothing comparable", () => {
    expect(addressesAgree("Alder Street", "412 Alder St")).toBeUndefined();
  });
});

describe("website links", () => {
  it("www and the scheme do not make a different host", () => {
    expect(sameHost("https://www.bucktavern.example/menu", "http://bucktavern.example")).toBe(true);
    expect(sameHost("https://buckhorn-tavern.example", "https://bucktavern.example")).toBe(false);
  });

  it("a link to the old domain is wrong even when it redirects to the site in one hop", () => {
    expect(
      websiteProblem(
        "https://buckhorn-tavern.example/",
        { status: 200, finalUrl: "https://bucktavern.example/", redirects: 1 },
        "bucktavern.example",
      ),
    ).toMatch(/links to buckhorn-tavern.example, which redirects to bucktavern.example/);
  });

  it("http to https to www is two redirects and not a problem", () => {
    expect(
      websiteProblem(
        "http://bucktavern.example/",
        { status: 200, finalUrl: "https://www.bucktavern.example/", redirects: 2 },
        "bucktavern.example",
      ),
    ).toBeUndefined();
  });

  it("names the old domain, the dead page, the redirect chain and a page that will not open", () => {
    const site = "bucktavern.example";
    expect(
      websiteProblem(
        "https://buckhorn-tavern.example/",
        { status: 200, finalUrl: "https://buckhorn-tavern.example/", redirects: 0 },
        site,
      ),
    ).toMatch(/links to buckhorn-tavern.example, not bucktavern.example/);
    expect(
      websiteProblem(
        "https://bucktavern.example/old-menu",
        { status: 404, finalUrl: "https://bucktavern.example/old-menu", redirects: 0 },
        site,
      ),
    ).toMatch(/answers 404/);
    expect(
      websiteProblem(
        "https://bucktavern.example/a",
        { status: 200, finalUrl: "https://bucktavern.example/d", redirects: 3 },
        site,
      ),
    ).toMatch(/3 redirects/);
    expect(
      websiteProblem("https://bucktavern.example/", { error: "timed out", redirects: 0 }, site),
    ).toMatch(/could not be opened/);
  });

  it("a link-in-bio page counts when it links to the site", () => {
    expect(
      websiteProblem(
        "https://links.example/bucktavern",
        {
          status: 200,
          finalUrl: "https://links.example/bucktavern",
          redirects: 0,
          linkHosts: ["links.example", "bucktavern.example"],
        },
        "bucktavern.example",
      ),
    ).toBeUndefined();
    expect(
      websiteProblem(
        "https://links.example/bucktavern",
        {
          status: 200,
          finalUrl: "https://links.example/bucktavern",
          redirects: 0,
          linkHosts: ["buckhorn-tavern.example"],
        },
        "bucktavern.example",
      ),
    ).toMatch(/does not link to bucktavern.example/);
  });
});
