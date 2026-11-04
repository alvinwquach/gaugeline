import { describe, expect, it } from "vitest";
import {
  ConfigError,
  CouldNotRunError,
  GaugelineError,
  NetworkError,
  errorCodes,
} from "../errors.js";
import type { FetchError } from "../fetcher.js";
import { createFetcher, describeNetworkFailure } from "../fetcher.js";
import { exitCodeFor, type Outcome } from "../outcome.js";
import { startServer } from "./helpers/server.js";

describe("exitCodeFor: unit (truth table)", () => {
  const failed: Outcome = { kind: "could-not-run", error: new ConfigError("bad") };
  const rows: Array<[string, Outcome, boolean, 0 | 1 | 2]> = [
    ["could-not-run, ci", failed, true, 2],
    ["could-not-run, no ci", failed, false, 2],
    ["ran 0 high, no drift, ci", { kind: "ran", highFindings: 0, drift: false }, true, 0],
    ["ran 0 high, no drift, no ci", { kind: "ran", highFindings: 0, drift: false }, false, 0],
    ["ran 3 high, no drift, ci", { kind: "ran", highFindings: 3, drift: false }, true, 1],
    ["ran 3 high, no drift, no ci", { kind: "ran", highFindings: 3, drift: false }, false, 0],
    ["ran 0 high, drift, ci", { kind: "ran", highFindings: 0, drift: true }, true, 1],
    ["ran 0 high, drift, no ci", { kind: "ran", highFindings: 0, drift: true }, false, 0],
    ["ran 3 high, drift, ci", { kind: "ran", highFindings: 3, drift: true }, true, 1],
  ];
  it("has nine rows", () => expect(rows).toHaveLength(9));
  it.each(rows)("%s -> %i", (_name, outcome, ci, code) => {
    expect(exitCodeFor(outcome, { ci })).toBe(code);
  });
});

describe("errors: unit", () => {
  it("NetworkError keeps cause, and instanceof CouldNotRunError and GaugelineError both hold", () => {
    const cause = new Error("getaddrinfo ENOTFOUND x.invalid");
    const err = new NetworkError("x.invalid could not be found.", {
      cause,
      url: "https://x.invalid/",
    });
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(CouldNotRunError);
    expect(err).toBeInstanceOf(GaugelineError);
    expect(err.code).toBe("network");
    expect(err.name).toBe("NetworkError");
  });

  it("ConfigError has code config and keeps its hint", () => {
    const err = new ConfigError("No address given.", { hint: "gaugeline example.com" });
    expect([err.code, err.hint, err instanceof CouldNotRunError]).toEqual([
      "config",
      "gaugeline example.com",
      true,
    ]);
  });

  it("errorCodes reads codes through causes and AggregateError members", () => {
    const agg = Object.assign(
      new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })], "x"),
      {},
    );
    const top = new Error("fetch failed", { cause: agg });
    expect(errorCodes(top)).toEqual(["ECONNREFUSED"]);
  });
});

describe("errors: integration (fetcher)", () => {
  it("fetcher against a closed port on 127.0.0.1 rejects with NetworkError whose message names the host", async () => {
    const s = await startServer({});
    const origin = s.origin;
    await s.close();
    const err = await createFetcher()
      .get(origin)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as FetchError).reason).toBe("refused");
    expect((err as Error).message).toContain(new URL(origin).host);
    expect((err as NetworkError).hint).toBeTruthy();
  });

  it('fetcher against a name that does not resolve (.invalid) gives the "could not be found" sentence', async () => {
    const err = await createFetcher({ timeoutMs: 5000 })
      .get("http://not-a-real-host.invalid/")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe(
      "not-a-real-host.invalid could not be found. Check the spelling.",
    );
  });
});

describe("errors: edge cases", () => {
  it("AggregateError from a dual-stack connect failure maps to one sentence, not a list", () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:80"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), { code: "ECONNREFUSED" }),
      ],
      "",
    );
    const d = describeNetworkFailure(
      "http://localhost/",
      new TypeError("fetch failed", { cause: agg }),
      10000,
    );
    expect(d.message).toBe("localhost refused the connection.");
    expect(d.message.split("\n")).toHaveLength(1);
  });

  it("certificate errors get their own sentence", () => {
    const d = describeNetworkFailure(
      "https://shop.example/",
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }),
      }),
      10000,
    );
    expect(d.reason).toBe("tls");
    expect(d.message).toContain("certificate");
  });

  it("ci true, zero high findings, drift true: exit 1", () => {
    expect(exitCodeFor({ kind: "ran", highFindings: 0, drift: true }, { ci: true })).toBe(1);
  });

  it("ci false with 12 high findings: exit 0", () => {
    expect(exitCodeFor({ kind: "ran", highFindings: 12, drift: false }, { ci: false })).toBe(0);
  });
});
