import { describe, expect, it } from "vitest";
import { publicSurface } from "../public-surface.js";

describe("publicSurface: unit", () => {
  it("returns sorted arrays and is identical across two calls", () => {
    const flags = { check: ["verbose", "ci", "json"] };
    const a = publicSurface({ flags, envVars: ["CI"] });
    const b = publicSurface({ flags, envVars: ["CI"] });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.flags.check).toEqual(["ci", "json", "verbose"]);
    expect(a.checkIds).toEqual([...a.checkIds].sort());
    expect(a.envVars).toEqual([...a.envVars].sort());
    expect(a.exitCodes).toEqual([0, 1, 2]);
    expect(a.jsonSchema).toBe(1);
    expect(Object.keys(a.severities)).toEqual(a.checkIds);
  });
});
