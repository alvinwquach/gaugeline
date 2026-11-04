import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, NetworkError, defineCheck } from "@gaugeline/core";
import { formatError, toOutcome } from "../fail.js";
import { main, type PageInput } from "../main.js";
import {
  html,
  startRawServer,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { runBin } from "./helpers/bin.js";

describe("formatError and toOutcome: unit", () => {
  it("ConfigError with hint, verbose false: exactly two lines, no Error: prefix, no stack frames", () => {
    const text = formatError(
      new ConfigError("No address given.", { hint: "gaugeline example.com" }),
      { verbose: false },
    );
    expect(text.split("\n")).toEqual(["No address given.", "Try: gaugeline example.com"]);
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(/\n\s*at /);
  });

  it("verbose true includes the stack and the cause's message", () => {
    const err = new NetworkError("shop.example could not be reached.", {
      url: "https://shop.example/",
      cause: new Error("connect ECONNRESET"),
    });
    const text = formatError(err, { verbose: true });
    expect(text).toMatch(/\n\s+at /);
    expect(text).toContain("Caused by: Error: connect ECONNRESET");
  });

  it("toOutcome on a string, undefined and a TypeError gives could-not-run with the generic sentence", () => {
    for (const thrown of ["a string", undefined, new TypeError("x is not a function")]) {
      const o = toOutcome(thrown);
      expect(o.kind).toBe("could-not-run");
      if (o.kind === "could-not-run")
        expect(o.error.message).toBe("Something went wrong inside Gaugeline.");
    }
  });

  it("toOutcome keeps a Gaugeline error as it is", () => {
    const err = new ConfigError("x");
    expect(toOutcome(err)).toEqual({ kind: "could-not-run", error: err });
  });
});

describe("formatError: edge cases", () => {
  it("a cause chain three deep prints all three under --verbose and none without", () => {
    const deepest = new Error("third");
    const middle = new Error("second", { cause: deepest });
    const err = new NetworkError("first", { url: "https://x.example/", cause: middle });
    const verbose = formatError(err, { verbose: true });
    for (const m of ["first", "second", "third"]) expect(verbose).toContain(m);
    const quiet = formatError(err, { verbose: false });
    expect(quiet).not.toContain("second");
    expect(quiet).not.toContain("third");
  });

  it("a message with a URL carrying a token query parameter: the query is stripped in the one-line form", () => {
    const err = new NetworkError("https://shop.example/api?token=abc123&x=1 did not answer.", {
      url: "https://shop.example/",
    });
    const line = formatError(err, { verbose: false });
    expect(line).toContain("https://shop.example/api did not answer.");
    expect(line).not.toContain("abc123");
  });
});

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({ "/": html("<title>t</title>") });
});
afterAll(() => site.close());

describe("CLI errors: e2e (built bin)", () => {
  it("gaugeline not-a-real-host.invalid: exit 2, stderr is two lines, stdout is empty", async () => {
    const r = await runBin(["not-a-real-host.invalid"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(2);
    expect(r.stderr).toContain("not-a-real-host.invalid could not be found. Check the spelling.");
  });

  it("same with --verbose: exit 2, stderr contains a stack frame", async () => {
    const r = await runBin(["not-a-real-host.invalid", "--verbose"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\n\s+at /);
  });

  it("no address and no subcommand: exit 2 and a hint that shows the usage line", async () => {
    const r = await runBin([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Try: gaugeline <address> [options]");
  });

  it("a fixture where one check throws: exit 0, the check id is in failed, the others still report", async () => {
    const base = { area: "Visitors", severity: "high", what: "w", why: "y", fix: "f" } as const;
    const checks = [
      defineCheck<PageInput>({
        ...base,
        id: "throws-here",
        title: "t",
        run: () => {
          throw new Error("bug");
        },
      }),
      defineCheck<PageInput>({
        ...base,
        id: "still-reports",
        title: "Still reports",
        run: (input) => [
          {
            checkId: "still-reports",
            severity: "high",
            title: "Still reports",
            evidence: "e",
            url: input.url,
          },
        ],
      }),
    ];
    const out: string[] = [];
    const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
    expect(await main([site.origin], io, { checks })).toBe(0);
    expect(out.join("")).toContain("Could not run: throws-here");
    expect(out.join("")).toContain("still-reports");
  });
});

describe("CLI errors: promise test (no secrets in error output)", () => {
  const env = { STRIPE_API_KEY: "MARKER_STRIPE_9f2c", SANITY_TOKEN: "MARKER_SANITY_41ab" };
  it("no marker appears in stderr on any error path, with or without --verbose", async () => {
    const silent = await startRawServer(() => undefined);
    const closed = await startServer({});
    const closedOrigin = closed.origin;
    await closed.close();
    try {
      const paths: string[][] = [
        [],
        ["--nope"],
        ["ftp://x.example"],
        ["not-a-real-host.invalid"],
        [closedOrigin],
        [`${closedOrigin}/?token=${env.STRIPE_API_KEY}`],
      ];
      for (const args of paths) {
        for (const extra of [[], ["--verbose"]]) {
          const r = await runBin([...args, ...extra], env);
          expect(r.status, args.join(" ")).toBe(2);
          for (const marker of Object.values(env)) {
            expect(r.stderr, args.join(" ")).not.toContain(marker);
            expect(r.stdout).not.toContain(marker);
          }
        }
      }
    } finally {
      await silent.close();
    }
  }, 60_000);
});
