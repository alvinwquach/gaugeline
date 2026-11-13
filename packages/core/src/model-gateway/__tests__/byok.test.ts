/**
 * Bring your own key (AG-20, ADR-0005 as amended: modes 1 and 2). The key is the person's, in the person's own
 * environment; Gaugeline holds none. Mode 3 (a key Gaugeline keeps, with metering) is parked and refused.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BYOK_MODES,
  MODE_3_MESSAGE,
  ByokError,
  LLM_CONFIG_FILE,
  createByokGateway,
  describeByok,
  readByokConfig,
  renderByokStatus,
} from "../byok.js";
import { createRecordedAdapter } from "../recorded.js";
import { KEY_NAME, ODD_KEY, PLAIN_KEY, REQUEST, SHAPED_KEY, testAdapter } from "./helpers.js";

/** An invented key in no shape the scanner knows, lower case so it fits the model id pattern. */
const LOWER_KEY = ["demo", "value", "a1b2c3d4e5f6g7h8i9j0"].join("-");
/** A short one: only the environment can tell it from a model id. */
const SHORT_KEY = ["demo", "k9x2m7"].join("-");

const FILE = JSON.stringify({
  provider: "test",
  keyEnv: KEY_NAME,
  tiers: { fast: "small-model", strong: "large-model" },
});
const root = fileURLToPath(new URL("../../../../../", import.meta.url));

describe("the modes", () => {
  it("are the command line and the customer's own worker, and no third", () => {
    expect([...BYOK_MODES]).toEqual(["cli", "worker"]);
  });

  it.each(["managed", "vault", "metered", "mode 3", "", "CLI"])(
    "refuses %j: a key Gaugeline holds is parked with billing",
    (mode) => {
      const { adapter } = testAdapter();
      let thrown: unknown;
      try {
        createByokGateway({
          mode: mode as never,
          config: readByokConfig(FILE),
          adapters: [adapter],
          env: () => ({}),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ByokError);
      expect((thrown as ByokError).code).toBe("mode-not-supported");
      expect((thrown as ByokError).message).toMatch(/parked/);
    },
  );
});

describe("the config file", () => {
  it("is named gaugeline.llm.json, and is read into the gateway's own config shape", () => {
    expect(LLM_CONFIG_FILE).toBe("gaugeline.llm.json");
    expect(readByokConfig(FILE)).toMatchObject({
      provider: "test",
      keyEnv: KEY_NAME,
      timeoutMs: 30_000,
    });
  });

  it.each([
    ["not JSON", "{"],
    ["a list", "[]"],
    ["a key as a setting", JSON.stringify({ ...JSON.parse(FILE), apiKey: PLAIN_KEY })],
    [
      "a key where the variable name goes",
      JSON.stringify({ ...JSON.parse(FILE), keyEnv: SHAPED_KEY }),
    ],
    [
      "a key-shaped string in a model id",
      JSON.stringify({ ...JSON.parse(FILE), tiers: { fast: SHAPED_KEY } }),
    ],
    ["a host", JSON.stringify({ ...JSON.parse(FILE), baseUrl: "https://api.example.test" })],
    ["no tiers", JSON.stringify({ provider: "test", tiers: {} })],
  ])("refuses %s, and never repeats a key it was given", (_n, text) => {
    let thrown: ByokError | undefined;
    try {
      readByokConfig(text);
    } catch (e) {
      thrown = e as ByokError;
    }
    expect(thrown).toBeInstanceOf(ByokError);
    expect(thrown!.code).toBe("bad-config");
    for (const k of [PLAIN_KEY, SHAPED_KEY]) expect(thrown!.message).not.toContain(k);
  });

  describe("a key pasted into a field that is printed back (the key's shape is not known to any scanner)", () => {
    const withTier = (v: string) => JSON.stringify({ ...JSON.parse(FILE), tiers: { fast: v } });
    const withProvider = (v: string) => JSON.stringify({ ...JSON.parse(FILE), provider: v });
    const refused = (text: string, env: Record<string, string | undefined> = {}) => {
      let thrown: ByokError | undefined;
      try {
        readByokConfig(text, env);
      } catch (e) {
        thrown = e as ByokError;
      }
      expect(thrown).toBeInstanceOf(ByokError);
      for (const k of [LOWER_KEY, SHORT_KEY, PLAIN_KEY]) expect(thrown!.message).not.toContain(k);
      return thrown!;
    };

    it.each([
      ["a model id", withTier],
      ["the provider", withProvider],
    ])("refuses the value of the key variable in %s, equal or inside a longer value", (_n, put) => {
      const env = { [KEY_NAME]: SHORT_KEY };
      refused(put(SHORT_KEY), env);
      refused(put(`prefix-${SHORT_KEY}-suffix`), env);
    });

    it.each([
      ["a model id", withTier],
      ["the provider", withProvider],
    ])(
      "refuses a long unbroken run of letters and digits in %s even when the variable is not set",
      (_n, put) => {
        refused(put(LOWER_KEY));
        refused(put("a".repeat(24)));
        refused(put("0123456789abcdef0123456789abcdef"));
      },
    );

    it("refuses a model id that is not lower case, or longer than 64 characters", () => {
      refused(withTier("Some-Model"));
      refused(withTier("a/b"));
      refused(withTier(`m${"-x".repeat(40)}`));
    });

    it("still accepts the ids real models have", () => {
      for (const id of [
        "gpt-4o-mini-2024-07-18",
        "model-3-5-sonnet-20241022",
        "small-model",
        "llama3.1:8b",
        "model-v2.5-instruct",
      ])
        expect(readByokConfig(withTier(id)).tiers.fast).toBe(id);
    });

    it("also refuses a key in an object key, and in the variable name", () => {
      refused(JSON.stringify({ ...JSON.parse(FILE), [SHORT_KEY]: 1 }), { [KEY_NAME]: SHORT_KEY });
      refused(JSON.stringify({ ...JSON.parse(FILE), keyEnv: SHORT_KEY }), {
        [SHORT_KEY]: SHORT_KEY,
      });
    });

    it("prints a config-derived string only after it passed, and hides the key value if one slipped in", () => {
      const config = { ...readByokConfig(FILE), provider: SHORT_KEY };
      const s = describeByok(config, { [KEY_NAME]: SHORT_KEY }, "cli");
      expect(JSON.stringify(s)).not.toContain(SHORT_KEY);
      expect(renderByokStatus(s)).not.toContain(SHORT_KEY);
    });
  });

  it.each([
    ["mode", { mode: "managed" }],
    ["Mode", { Mode: 3 }],
    ["managed", { managed: true }],
    ["vault", { vault: { path: "secret/model" } }],
    ["metered", { metered: true }],
    ["metering", { metering: { perDay: 5 } }],
    ["billing", { billing: "plan" }],
  ])(
    "says mode 3 is parked when the file asks for it (%s), not that the setting is unknown",
    (_n, extra) => {
      let thrown: ByokError | undefined;
      try {
        readByokConfig(JSON.stringify({ ...JSON.parse(FILE), ...extra }));
      } catch (e) {
        thrown = e as ByokError;
      }
      expect(thrown).toBeInstanceOf(ByokError);
      expect(thrown!.code).toBe("mode-not-supported");
      expect(thrown!.message).toBe(MODE_3_MESSAGE);
      expect(thrown!.message).toMatch(
        /Mode 3 \(a key Gaugeline holds for you, with metering\) is parked/,
      );
    },
  );

  describe("a key in no shape anyone knows, in any field, with the variable not set", () => {
    const UUID = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
    const HEX_DASH = "0123abcd-4567-89ef-0123-456789abcdef-01234567";
    const BASE32 = "mfrggzdfmztwq2lknnwg23tpobyxe43u";
    const UNDER = "k9x2m7_q4w8e1_r5t6y3_u0i2o7";
    const KEYS = [UUID, HEX_DASH, BASE32, UNDER];
    const base = JSON.parse(FILE);
    const files = (k: string) =>
      [
        ["a model id", { ...base, tiers: { fast: k } }],
        ["the second model id", { ...base, tiers: { fast: "small-model", strong: k } }],
        ["the provider", { ...base, provider: k }],
        ["the variable name", { ...base, keyEnv: k }],
        ["a setting name", { ...base, [k]: 1 }],
        ["a nested name", { ...base, tiers: { fast: "small-model", [k]: "x" } }],
      ] as const;

    it.each(KEYS)(
      "refuses %s in every field it could be printed from, and never repeats it",
      (key) => {
        for (const [where, content] of files(key)) {
          let thrown: ByokError | undefined;
          try {
            readByokConfig(JSON.stringify(content));
          } catch (e) {
            thrown = e as ByokError;
          }
          expect(thrown, where).toBeInstanceOf(ByokError);
          expect(thrown!.message, where).not.toContain(key);
        }
      },
    );

    it("prints a provider or model id that is not on the known list masked: three characters and a length", () => {
      const config = readByokConfig(
        JSON.stringify({
          provider: "acme-ai",
          keyEnv: "OPENAI_API_KEY",
          tiers: { fast: "acme-large-2026" },
        }),
      );
      const s = describeByok(config, {}, "cli");
      expect(s.provider).toBe("acm... (a provider name of 7 characters, not on the known list)");
      expect(s.tiers.fast).toBe("acm... (a model id of 15 characters, not on the known list)");
      const text = renderByokStatus(s);
      expect(text).not.toContain("acme-ai");
      expect(text).not.toContain("acme-large-2026");
    });

    it("prints a known provider and a known model id as written", () => {
      const config = readByokConfig(
        JSON.stringify({
          provider: "example",
          keyEnv: "EXAMPLE_API_KEY",
          tiers: { fast: "example-small", strong: "example-large-2026-01-15" },
        }),
      );
      const s = describeByok(config, {}, "cli");
      expect(s).toMatchObject({
        provider: "example",
        tiers: { fast: "example-small", strong: "example-large-2026-01-15" },
      });
    });

    it("never prints an accepted custom value in full, in the status, the text or the JSON, even if it has a key's own shape", () => {
      // Accepted by the shape rule (words and short numbers), so only the mask stands between it and the screen.
      const custom = "abc1-def2-ghi3-jkl4-mno5";
      const config = readByokConfig(
        JSON.stringify({
          ...base,
          provider: "recorded",
          keyEnv: undefined,
          tiers: { fast: custom },
        }),
      );
      const s = describeByok(config, {}, "worker");
      for (const shown of [JSON.stringify(s), renderByokStatus(s)])
        expect(shown).not.toContain(custom);
    });
  });

  it("says mode 3 is parked for a mode 3 setting nested in the file too, tiers.mode included", () => {
    for (const nested of [
      { ...JSON.parse(FILE), tiers: { fast: "small-model", mode: "managed" } },
      { ...JSON.parse(FILE), extra: { deeper: { vault: 1 } } },
      { ...JSON.parse(FILE), list: [{ metered: true }] },
    ])
      expect(() => readByokConfig(JSON.stringify(nested))).toThrow(MODE_3_MESSAGE);
  });

  it("refuses a file over 20000 characters before parsing it", () => {
    expect(() => readByokConfig(`{"provider":"x"${" ".repeat(20_001)}}`)).toThrow(/20000/);
  });
});

describe("describeByok: what is set up, never the key", () => {
  const config = readByokConfig(FILE);

  it("says the key is set, by name, and shows nothing of its value", () => {
    const s = describeByok(config, { [KEY_NAME]: ODD_KEY }, "cli");
    expect(s).toMatchObject({ mode: "cli", keyEnv: KEY_NAME, keySet: true });
    expect(JSON.stringify(s)).not.toContain(ODD_KEY);
    expect(renderByokStatus(s)).not.toContain(ODD_KEY);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blanks", "   "],
    ["with a line break", `${PLAIN_KEY}\nX: 1`],
    ["too short", "abc"],
  ])("says the key is not set when it is %s", (_n, value) => {
    const s = describeByok(config, { [KEY_NAME]: value }, "worker");
    expect(s.keySet).toBe(false);
    expect(renderByokStatus(s)).toContain(`${KEY_NAME} is not set`);
  });

  it("says where the call runs and what Gaugeline keeps, for each mode", () => {
    const cli = renderByokStatus(describeByok(config, { [KEY_NAME]: PLAIN_KEY }, "cli"));
    const worker = renderByokStatus(describeByok(config, { [KEY_NAME]: PLAIN_KEY }, "worker"));
    expect(cli).toMatch(/this command line/);
    expect(worker).toMatch(/your own worker/);
    for (const t of [cli, worker]) expect(t).toMatch(/Gaugeline keeps no key/);
  });

  it("reads nothing but the one variable the config names", () => {
    const seen: string[] = [];
    const env = new Proxy({ [KEY_NAME]: PLAIN_KEY } as Record<string, string | undefined>, {
      get: (t, p) => (seen.push(String(p)), t[p as string]),
      ownKeys: () => {
        throw new Error("the environment was listed");
      },
    });
    describeByok(config, env, "cli");
    expect(seen).toEqual([KEY_NAME]);
  });

  it("does not need a key for a provider that has none (the recorded fake)", () => {
    const c = readByokConfig(JSON.stringify({ provider: "recorded", tiers: { fast: "x" } }));
    expect(describeByok(c, {}, "cli")).toMatchObject({ keySet: null, keyEnv: null });
    expect(renderByokStatus(describeByok(c, {}, "cli"))).toMatch(/needs no key/);
  });
});

describe("createByokGateway", () => {
  it("is the gateway, for either mode, with the key read from the environment handed in at each call", async () => {
    for (const mode of BYOK_MODES) {
      const { adapter, calls } = testAdapter();
      const env: Record<string, string | undefined> = { [KEY_NAME]: PLAIN_KEY };
      const g = createByokGateway({
        mode,
        config: readByokConfig(FILE),
        adapters: [adapter],
        env: () => env,
      });
      await g.complete(REQUEST);
      expect(calls[0]!.key?.reveal()).toBe(PLAIN_KEY);
      delete env[KEY_NAME];
      await expect(g.complete(REQUEST)).rejects.toMatchObject({ code: "missing-key" });
    }
  });

  it("works with the recorded fake and no key at all", async () => {
    const g = createByokGateway({
      mode: "cli",
      config: readByokConfig(JSON.stringify({ provider: "recorded", tiers: { fast: "x" } })),
      adapters: [
        createRecordedAdapter(
          new Map([
            [
              "call-1",
              {
                text: "ok",
                usage: { inputTokens: 1, outputTokens: 1, costMicros: 0, latencyMs: 0 },
              },
            ],
          ]),
        ),
      ],
      env: () => ({}),
    });
    expect((await g.complete(REQUEST)).text).toBe("ok");
  });
});

describe("Gaugeline stores no key", () => {
  const walk = (dir: string, keep: (f: string) => boolean): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (["node_modules", "dist", ".next", ".turbo", "__tests__"].includes(n)) return [];
      const full = join(dir, n);
      return statSync(full).isDirectory() ? walk(full, keep) : keep(n) ? [full] : [];
    });
  const gatewayFiles = walk(join(root, "packages/core/src/model-gateway"), (n) =>
    n.endsWith(".ts"),
  );

  it("the gateway writes no file, keeps no key in a global, and never reads the process environment", () => {
    expect(gatewayFiles.length).toBeGreaterThan(8);
    for (const f of gatewayFiles)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /node:fs|writeFile|appendFile|createWriteStream|localStorage|sessionStorage|process\s*\.\s*env|globalThis\s*\./,
      );
  });

  it("the hosted app never imports the gateway or the sender: its own service makes no model call", () => {
    const files = walk(
      join(root, "apps/hosted"),
      (n) => /\.(ts|tsx|sql|json)$/.test(n) && n !== "package.json",
    );
    expect(files.length).toBeGreaterThan(20);
    for (const f of files)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /model-gateway|createGateway|createByokGateway|createProviderAdapter/,
      );
  });

  it("no hosted table or column holds a model key", () => {
    const sql = walk(join(root, "apps/hosted/db"), (n) => n.endsWith(".sql"));
    expect(sql.length).toBeGreaterThan(5);
    for (const f of sql)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /\b(model|llm|provider|openai|ai)_?(api_?)?(key|token|secret)\b/i,
      );
  });
});
