// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../fetcher.js";
import { compareAddresses, normaliseText, normaliseUrl, sameText } from "../normalise.js";
import { ADDRESS_CASES, TEXT_CASES, URL_CASES } from "./corpus/normalise.corpus.js";
import { html, startServer, type FixtureServer } from "./helpers/server.js";

describe("normaliseUrl: corpus", () => {
  it.each(URL_CASES)("%s", (_name, input, expected) => {
    const [rel, base] = input.split("|") as [string, string | undefined];
    expect(normaliseUrl(rel, base)).toBe(expected);
  });
});

describe("compareAddresses: corpus", () => {
  it.each(ADDRESS_CASES)("%s", (_name, a, b, opts, expected) => {
    expect(compareAddresses(a, b, opts)).toEqual(expected);
  });
});

describe("sameText: corpus", () => {
  it.each(TEXT_CASES)("%s", (_name, a, b, expected) => {
    expect(sameText(a, b)).toBe(expected);
  });
});

describe("corpus meta", () => {
  const names = [...URL_CASES, ...ADDRESS_CASES, ...TEXT_CASES].map((c) => c[0]);
  it("has at least 60 cases and at least 20 per table", () => {
    expect(names.length).toBeGreaterThanOrEqual(60);
    for (const table of [URL_CASES, ADDRESS_CASES, TEXT_CASES])
      expect(table.length).toBeGreaterThanOrEqual(20);
  });
  it("has no duplicate names", () => {
    expect(new Set(names).size).toBe(names.length);
  });
});

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("normalise: integration", () => {
  it("the fetcher's memo dedupes an uppercase scheme and a fragment to one request", async () => {
    const s = await startServer({ "/a": html("x") });
    servers.push(s);
    const f = createFetcher({ allowPrivate: true });
    const port = s.port;
    // An IP host, not "localhost": Node 18 may resolve localhost to ::1 first.
    await f.get(`HTTP://127.0.0.1:${port}/a#x`);
    await f.get(`http://127.0.0.1:${port}/a`);
    expect(s.log).toHaveLength(1);
    // the spec's own pair, normalised to one memo key
    expect(normaliseUrl("https://Example.com:443/a#x")).toBe(normaliseUrl("https://example.com/a"));
  });
});

describe("normalise: edge cases", () => {
  const options = [
    {},
    { www: "same" },
    { trailingSlash: "distinct" },
    { query: "ignore" },
  ] as const;
  it("root path: https://example.com and https://example.com/ are the same under every option", () => {
    for (const o of options)
      expect(compareAddresses("https://example.com", "https://example.com/", o)).toEqual({
        same: true,
      });
  });

  it("trailing slash before a query: /a/?x=1 vs /a?x=1", () => {
    expect(compareAddresses("https://e.example/a/?x=1", "https://e.example/a?x=1")).toEqual({
      same: true,
    });
    expect(
      compareAddresses("https://e.example/a/?x=1", "https://e.example/a?x=1", {
        trailingSlash: "distinct",
      }),
    ).toEqual({
      same: false,
      differsBy: ["trailing-slash"],
    });
  });

  it("composed vs decomposed e-acute compare the same; Cyrillic vs Latin a do not", () => {
    expect(normaliseText("Cafe\u0301")).toBe("Café");
    expect(sameText("\u0430", "a")).toBe(false);
  });

  it('empty and whitespace-only: normaliseText returns "", sameText("", " ") is true', () => {
    expect(normaliseText("")).toBe("");
    expect(normaliseText(" \u00A0\t\n")).toBe("");
    expect(sameText("", " ")).toBe(true);
  });

  it("case-sensitive comparison on request", () => {
    expect(sameText("Menu", "menu", { caseSensitive: true })).toBe(false);
    expect(normaliseText("Menu")).toBe("Menu");
  });

  it("www.www.example.com: only one leading www label is considered", () => {
    expect(compareAddresses("https://www.www.example.com/", "https://www.example.com/")).toEqual({
      same: false,
      differsBy: ["www"],
    });
    expect(
      compareAddresses("https://www.www.example.com/", "https://example.com/", { www: "same" }),
    ).toEqual({
      same: false,
      differsBy: ["host"],
    });
  });

  it("userinfo: the comparison ignores nothing, and the result never echoes the password", () => {
    const r = compareAddresses("https://user:hunter2@example.com/", "https://example.com/");
    expect(r).toEqual({ same: false, differsBy: ["host"] });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("mailto: and tel: return same false, differsBy scheme, without throwing", () => {
    expect(compareAddresses("mailto:hi@example.com", "https://example.com/")).toEqual({
      same: false,
      differsBy: ["scheme"],
    });
    expect(compareAddresses("tel:+15555550100", "tel:+15555550199")).toEqual({
      same: false,
      differsBy: ["scheme"],
    });
    expect(compareAddresses("mailto:a@example.com", "mailto:a@example.com")).toEqual({
      same: true,
    });
  });
});
