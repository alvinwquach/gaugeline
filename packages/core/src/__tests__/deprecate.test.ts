import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPRECATED, deprecate, resetDeprecations } from "../deprecate.js";

afterEach(() => {
  resetDeprecations();
  vi.restoreAllMocks();
});
const opts = { since: "0.0.2", removeIn: "0.4.0", use: "--new-flag" };

describe("deprecate: unit", () => {
  it("called three times with one key calls the sink once", () => {
    const sink = vi.fn();
    for (let i = 0; i < 3; i++) deprecate("--old-flag", opts, sink);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("two keys call the sink twice, in call order", () => {
    const lines: string[] = [];
    deprecate("--b-flag", opts, (l) => lines.push(l));
    deprecate("--a-flag", opts, (l) => lines.push(l));
    deprecate("--b-flag", opts, (l) => lines.push(l));
    expect(lines.map((l) => l.split(" ")[1])).toEqual(["--b-flag", "--a-flag"]);
  });

  it("the line contains the key, the removal version and the replacement when given", () => {
    const lines: string[] = [];
    deprecate("--old-flag", opts, (l) => lines.push(l));
    deprecate("env:OLD_NAME", { since: "0.0.2", removeIn: "0.5.0" }, (l) => lines.push(l));
    expect(lines).toEqual([
      "Deprecated: --old-flag will be removed in 0.4.0. Use --new-flag instead.",
      "Deprecated: env:OLD_NAME will be removed in 0.5.0.",
    ]);
  });

  it("deprecate never writes to stdout or stderr itself (core does not touch the process)", () => {
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    deprecate("--quiet-flag", opts);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("nothing is deprecated yet", () => {
    expect(DEPRECATED.size).toBe(0);
  });
});
