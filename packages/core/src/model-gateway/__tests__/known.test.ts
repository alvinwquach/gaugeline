import { describe, expect, it } from "vitest";
import {
  KNOWN_KEY_ENVS,
  KNOWN_PROVIDERS,
  isKnownKeyEnv,
  isKnownModelId,
  NOT_ON_LIST,
  isNameShaped,
  shownAnyModelId,
  shownModelId,
  shownSettingName,
  shownProvider,
} from "../known.js";

describe("the closed lists", () => {
  it("name only providers the adapter registry has", () => {
    expect([...KNOWN_PROVIDERS]).toEqual(["example", "recorded"]);
    expect(Object.isFrozen(KNOWN_PROVIDERS)).toBe(true);
  });

  it("hold only variables of the form NAME_API_KEY, once each, in order, and no service Gaugeline works with", () => {
    expect(KNOWN_KEY_ENVS.length).toBeGreaterThan(5);
    expect(new Set(KNOWN_KEY_ENVS).size).toBe(KNOWN_KEY_ENVS.length);
    expect([...KNOWN_KEY_ENVS]).toEqual([...KNOWN_KEY_ENVS].sort());
    for (const n of KNOWN_KEY_ENVS) {
      expect(n).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
      expect(n).not.toMatch(
        /GITHUB|GITLAB|STRIPE|SLACK|DISCORD|RESEND|SANITY|SUPABASE|GMAIL|NPM|AWS|DATABASE|SENTRY|TWILIO|SENDGRID/,
      );
    }
    expect(Object.isFrozen(KNOWN_KEY_ENVS)).toBe(true);
    expect(isKnownKeyEnv("OPENAI_API_KEY")).toBe(true);
    for (const n of ["GITHUB_TOKEN", "PATH", "openai_api_key", "OPENAI_API_KEY ", "GH_API_KEY"])
      expect(isKnownKeyEnv(n)).toBe(false);
  });

  it("know a model id only by its exact shape, per provider", () => {
    expect(isKnownModelId("example", "example-small")).toBe(true);
    expect(isKnownModelId("example", "example-large-2026-01-15")).toBe(true);
    expect(isKnownModelId("recorded", "recorded-small")).toBe(true);
    for (const [p, id] of [
      ["example", "example-small-x"],
      ["example", "recorded-small"],
      ["other", "example-small"],
      ["example", "example-medium"],
    ] as const)
      expect(isKnownModelId(p, id), `${p} ${id}`).toBe(false);
  });
});

describe("isNameShaped: words and short version numbers, never a key", () => {
  it.each([
    "small-model",
    "gpt-4o-mini-2024-07-18",
    "model-3-5-sonnet-20241022",
    "llama3.1:8b",
    "model-v2.5-instruct",
    "acme-ai",
    "x",
    "recorded-small",
  ])("accepts %s", (v) => expect(isNameShaped(v)).toBe(true));

  it.each([
    ["a UUID", "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c"],
    ["a UUID without dashes", "3f2a9c1e7b4d4e8a9c215d6e7f8a9b0c"],
    ["hex with dashes", "0123abcd-4567-89ef-0123-456789abcdef"],
    ["base32", "mfrggzdfmztwq2lknnwg23tpobyxe43u"],
    ["underscores", "k9x2m7_q4w8e1_r5t6y3"],
    ["upper case", "Small-Model"],
    ["a long letters run", "abcdefghijklmnopqrstuvwxyz"],
    ["a long mixed run", "a1b2c3d4e5f6"],
    ["empty", ""],
    ["a slash", "a/b"],
    ["more than 48 characters", `${"ab-".repeat(17)}ab`],
    ["more than ten parts", "a-b-c-d-e-f-g-h-i-j-k"],
    ["a leading dash", "-abc"],
  ])("refuses %s", (_n, v) => expect(isNameShaped(v)).toBe(false));
});

describe("what may be printed", () => {
  it("prints a known provider and model as written, and anything else as one fixed text: no character, no length", () => {
    expect(NOT_ON_LIST).toBe("[not on the known list]");
    expect(shownProvider("example")).toBe("example");
    expect(shownProvider("acme-ai")).toBe(NOT_ON_LIST);
    expect(shownModelId("example", "example-small")).toBe("example-small");
    expect(shownModelId("example", "other-model")).toBe(NOT_ON_LIST);
    expect(shownModelId("other", "example-small")).toBe(NOT_ON_LIST);
    expect(shownAnyModelId("recorded-large")).toBe("recorded-large");
    expect(shownAnyModelId("qzvkwmplrtyhbnxc")).toBe(NOT_ON_LIST);
  });

  it("gives nothing away about a string it hides: the same text for a short and a long one, a key and a word", () => {
    for (const v of [
      "sk-ant-qzvkwmplrtyhbnxc-fjdkslaqpwoeiru",
      "qzvkwmplrtyhbnxc",
      "abc-1-def-2-ghi-3",
      "x",
    ])
      expect(shownProvider(v)).toBe(NOT_ON_LIST);
  });

  it("knows an example model with a date only if the date is a real one", () => {
    for (const ok of ["example-small", "example-large-2026-01-15", "example-small-2024-02-29"])
      expect(isKnownModelId("example", ok), ok).toBe(true);
    for (const bad of [
      "example-small-9384-71-62",
      "example-small-2026-13-01",
      "example-small-2026-02-30",
      "example-small-2023-02-29",
      "example-small-0000-00-00",
      "example-small-2026-1-5",
      "example-small-20260115",
    ])
      expect(isKnownModelId("example", bad), bad).toBe(false);
  });

  it("shows a setting's name only for a recognised mistake or a near miss of a real setting", () => {
    expect(shownSettingName("apiKey", ["tiers"])).toBe("apiKey");
    expect(shownSettingName("tires", ["tiers"])).toBe("tires");
    expect(shownSettingName("qzvkwmplrtyhbnxc", ["tiers"])).toBe("a setting");
    expect(shownSettingName("something", ["tiers"])).toBe("a setting");
  });
});
