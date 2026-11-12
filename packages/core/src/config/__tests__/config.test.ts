import { describe, expect, it } from "vitest";
import { ConfigError, defineCheck, type Check } from "../../index.js";
import { CheckRegistry } from "../../model.js";
import { parseConfig, registerCustomChecks } from "../schema.js";
import { sandboxCustomCheck } from "../custom.js";

function mine(id: string): Check<unknown> {
  return defineCheck({
    id,
    area: "Visitors",
    severity: "low",
    title: "Opening hours missing",
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
    size: "S",
    done: "d",
    estimateChanges: "e",
    run: () => [],
  });
}

function message(raw: unknown): string {
  try {
    parseConfig(raw, "gaugeline.config.json");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
}

describe("config schema: unit", () => {
  it("accepts an empty file and the three modes", () => {
    expect(parseConfig({}, "c")).toEqual({ checks: {}, custom: [], suppress: [] });
    const c = parseConfig({ checks: { "canonical-elsewhere": "block", x: "warn", y: "off" } }, "c");
    expect(c.checks).toEqual({ "canonical-elsewhere": "block", x: "warn", y: "off" });
  });

  it("every invalid shape gives a message naming the key", () => {
    expect(message([])).toContain("the file");
    expect(message({ checks: [] })).toContain("checks");
    expect(message({ checks: { "canonical-elsewhere": "fail" } })).toContain(
      "checks.canonical-elsewhere",
    );
    expect(message({ custom: "x" })).toContain("custom");
    expect(message({ custom: [{ id: "x" }] })).toContain("custom.0");
    expect(message({ suppress: {} })).toContain("suppress");
    expect(message({ suppress: [{ until: "2026-12-01", reason: "r" }] })).toContain(
      "suppress.0.id",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-12-01" }] })).toContain(
      "suppress.0.reason",
    );
    expect(message({ suppress: [{ id: "a", until: "soon", reason: "r" }] })).toContain(
      "suppress.0.until",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-02-30", reason: "r" }] })).toContain(
      "suppress.0.until",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-12-01", reason: "  " }] })).toContain(
      "suppress.0.reason",
    );
  });

  it("names every file path with the file's name", () => {
    expect(message({ checks: 3 })).toMatch(/^gaugeline\.config\.json: /);
  });

  it("a suppression with no date is a config error", () => {
    const m = message({ suppress: [{ id: "a", reason: "client is away" }] });
    expect(m).toContain("suppress.0.until");
    expect(m).toContain("date");
  });

  it("an unknown key is refused by name: a file cannot carry --allow-private or --owner-consent", () => {
    expect(message({ allowPrivate: true })).toContain("allowPrivate");
    expect(message({ ownerConsent: true })).toContain("ownerConsent");
    expect(message({ fetcher: { guard: false } })).toContain("fetcher");
  });

  it("a custom check is validated like a built-in: a bad id is named", () => {
    const bad = { ...mine("fine"), id: "Not Kebab" };
    expect(message({ custom: [bad] })).toContain("custom.0");
  });
});

describe("custom checks: shape", () => {
  it("an area or severity that does not exist is a config error naming the check", () => {
    expect(message({ custom: [{ ...mine("ok-rule"), area: "content" }] })).toContain("custom.0");
    expect(message({ custom: [{ ...mine("ok-rule"), severity: "urgent" }] })).toContain("custom.0");
  });
});

describe("a custom check runs in a smaller context", () => {
  const spy = { got: undefined as unknown };
  const probing = defineCheck({
    ...mine("probing-rule"),
    run: (_page, ctx) => {
      spy.got = ctx;
      return [];
    },
  });
  it("gets get, warn, couldNotCheck and now: no query, no consent, no site readers", async () => {
    const wrapped = sandboxCustomCheck(probing);
    const fetcher = {
      get: async () => [],
      query: async () => ({}),
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    };
    await wrapped.run({}, {
      warn: () => undefined,
      couldNotCheck: () => undefined,
      ownerConsent: true,
      fetcher,
      pages: async () => [],
      now: () => new Date(0),
    } as never);
    const ctx = spy.got as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["couldNotCheck", "fetcher", "now", "warn"].sort());
    expect(Object.keys(ctx.fetcher as object)).toEqual(["get"]);
    expect(ctx.ownerConsent).toBeUndefined();
  });

  it("a finding for another check id, or with an unknown severity, fails the check (isolated by the runner)", async () => {
    const wrongId = sandboxCustomCheck(
      defineCheck({
        ...mine("mine-rule"),
        run: () => [
          { checkId: "canonical-elsewhere", severity: "low", title: "t", evidence: "e", url: "u" },
        ],
      }),
    );
    await expect(wrongId.run({}, { warn: () => undefined })).rejects.toThrow(/canonical-elsewhere/);
    const wrongSeverity = sandboxCustomCheck(
      defineCheck({
        ...mine("mine-rule"),
        run: () => [
          {
            checkId: "mine-rule",
            severity: "urgent",
            title: "t",
            evidence: "e",
            url: "u",
          } as never,
        ],
      }),
    );
    await expect(wrongSeverity.run({}, { warn: () => undefined })).rejects.toThrow(/urgent/);
  });
});

describe("a custom check is not a way round the probing rule (rule 14)", () => {
  function asked(urls: string[], consent: boolean, headers?: Record<string, string>) {
    const calls: string[] = [];
    const fetcher = {
      get: async (url: string, _opts?: unknown) => {
        calls.push(url);
        return [];
      },
    };
    const check = sandboxCustomCheck(
      defineCheck({
        ...mine("fetching-rule"),
        run: async (_page, ctx) => {
          for (const u of urls)
            await (ctx as never as { fetcher: typeof fetcher }).fetcher.get(
              u,
              headers ? { headers } : (undefined as never),
            );
          return [];
        },
      }),
    );
    return {
      calls,
      result: check.run({}, {
        warn: () => undefined,
        fetcher,
        ...(consent ? { ownerConsent: true } : {}),
      } as never),
    };
  }

  const refused = [
    ["a dot path", "https://bar.example/.env"],
    ["a dot path deeper down", "https://bar.example/blog/.git/config"],
    ["an admin path", "https://bar.example/wp-admin/"],
    ["an admin path", "https://bar.example/admin"],
    ["an administrator path", "https://bar.example/administrator/index.php"],
    ["a percent-encoded dot", "https://bar.example/%2eenv"],
    ["a percent-encoded dot, upper case", "https://bar.example/%2Eenv"],
    ["a percent-encoded dot before .git", "https://bar.example/%2egit/config"],
    ["a dot-dot segment that lands on .env", "https://bar.example/%2e%2e/.env"],
    ["a dot-dot segment in the middle", "https://bar.example/a/%2e%2e/.env"],
    ["an encoded letter after the dot", "https://bar.example/.%65nv"],
    ["a double-encoded dot", "https://bar.example/%252eenv"],
    ["a triple-encoded dot", "https://bar.example/%25252eenv"],
    ["an encoded slash in a segment", "https://bar.example/a%2f.env"],
    ["an encoded backslash", "https://bar.example/a%5c.env"],
    ["an encoded NUL", "https://bar.example/menu%00.png"],
    ["a segment that does not decode", "https://bar.example/%E0%A4%A"],
    ["an encoded admin", "https://bar.example/%61dmin"],
    ["admin with an encoded slash", "https://bar.example/admin%2f"],
    ["wp-admin with an encoded slash", "https://bar.example/wp-admin%2Fx"],
    ["admin with a trailing dot", "https://bar.example/admin."],
    ["admin.php", "https://bar.example/admin.php"],
    ["wp-admin with a suffix", "https://bar.example/wp-admin-old/"],
    ["wp-login.php", "https://bar.example/wp-login.php"],
  ] as const;

  for (const [what, url] of refused) {
    it(`without consent ${what} (${url}) is refused before a request`, async () => {
      const { calls, result } = asked([url], false);
      await expect(result).rejects.toThrow(/--owner-consent/);
      expect(calls).toEqual([]);
    });
    it(`with consent ${what} (${url}) is asked for: get only`, async () => {
      const { calls, result } = asked([url], true);
      await result;
      expect(calls).toEqual([url]);
    });
  }

  it("public paths, including /.well-known/, are asked for without consent", async () => {
    const urls = ["https://bar.example/menu", "https://bar.example/.well-known/security.txt"];
    const { calls, result } = asked(urls, false);
    await result;
    expect(calls).toEqual(urls);
  });

  for (const name of [
    "Authorization",
    "x-api-key",
    "Cookie",
    "X-Auth-Token",
    "apikey",
    "X-Session",
    "X-Session-Id",
    "X-CSRF-Token",
    "X-XSRF-Header",
    "Proxy-Authorization",
  ]) {
    it(`without consent the header ${name} is refused; with consent it is sent`, async () => {
      const no = asked(["https://bar.example/menu"], false, { [name]: "v" });
      await expect(no.result).rejects.toThrow(/header/);
      expect(no.calls).toEqual([]);
      const yes = asked(["https://bar.example/menu"], true, { [name]: "v" });
      await yes.result;
      expect(yes.calls).toEqual(["https://bar.example/menu"]);
    });
  }

  it("a harmless header is fine without consent", async () => {
    const { calls, result } = asked(["https://bar.example/menu"], false, { accept: "text/html" });
    await result;
    expect(calls).toHaveLength(1);
  });
});

describe("custom checks and built-ins", () => {
  it("an id of a check that is not in this run's registry but ships with Gaugeline is refused too", () => {
    const reserved = new Set(["wp-users-exposed"]);
    expect(() =>
      registerCustomChecks(new CheckRegistry(), [mine("wp-users-exposed")], "c", reserved),
    ).toThrow(/custom\.0\.id.*built-in/);
  });

  it("a custom id must not collide with a built-in", () => {
    const registry = new CheckRegistry().register(mine("canonical-elsewhere"));
    const config = parseConfig({ custom: [mine("canonical-elsewhere")] }, "c");
    expect(() => registerCustomChecks(registry, config.custom, "c")).toThrow(/custom\.0\.id/);
    expect(() => registerCustomChecks(registry, config.custom, "c")).toThrow(/built-in/);
  });

  it("two custom checks with one id collide too", () => {
    const config = parseConfig({ custom: [mine("my-rule"), mine("my-rule")] }, "c");
    expect(() => registerCustomChecks(new CheckRegistry(), config.custom, "c")).toThrow(
      /custom\.1\.id/,
    );
  });

  it("registers a custom check that does not collide", () => {
    const registry = new CheckRegistry();
    registerCustomChecks(registry, [mine("hours-listed")], "c");
    expect(registry.has("hours-listed")).toBe(true);
  });
});
