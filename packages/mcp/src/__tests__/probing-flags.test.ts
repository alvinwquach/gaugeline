import { describe, expect, it } from "vitest";
import { HELP, parseArgs } from "../cli.js";
import { probingAllowedFor } from "../state.js";

describe("the operator's probing flags", () => {
  it("--allow-probing and --probing-origin go together: one without the other is refused", () => {
    expect(() => parseArgs(["--allow-probing"], "/")).toThrow(/go together/);
    expect(() => parseArgs(["--probing-origin", "https://harbourline.example"], "/")).toThrow(
      /go together/,
    );
    const ok = parseArgs(
      ["--allow-probing", "--probing-origin", "https://harbourline.example/menu"],
      "/",
    );
    expect(ok.allowProbing).toBe(true);
    // An origin, not a page: the path is dropped.
    expect(ok.probingOrigins).toEqual(["https://harbourline.example"]);
  });

  it("refuses an origin that is not http or https", () => {
    for (const bad of ["file:///etc", "harbourline.example", "ftp://harbourline.example"])
      expect(() => parseArgs(["--allow-probing", "--probing-origin", bad], "/")).toThrow(
        /--probing-origin needs/,
      );
  });

  it("is off by default and says in --help that a tool call cannot turn it on", () => {
    const d = parseArgs([], "/");
    expect(d.allowProbing).toBe(false);
    expect(d.probingOrigins).toEqual([]);
    expect(HELP).toContain("--allow-probing");
    expect(HELP).toContain("--probing-origin");
    expect(HELP).not.toMatch(/passes ownerConsent: true/);
  });

  it("decides by the exact origin: scheme, host and port", () => {
    const options = { allowProbing: true, probingOrigins: ["https://harbourline.example"] };
    expect(probingAllowedFor(options, "https://harbourline.example/menu")).toBe(true);
    for (const other of [
      "http://harbourline.example/",
      "https://harbourline.example:8443/",
      "https://www.harbourline.example/",
      "https://harbourline.example.attacker.example/",
      `https://harbourline.example${"@"}attacker.example/`,
      "not a url",
    ])
      expect(probingAllowedFor(options, other), other).toBe(false);
    expect(
      probingAllowedFor({ ...options, allowProbing: false }, "https://harbourline.example/"),
    ).toBe(false);
    expect(probingAllowedFor({ allowProbing: true }, "https://harbourline.example/")).toBe(false);
  });
});
