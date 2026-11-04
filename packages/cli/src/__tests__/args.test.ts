import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { main, EXIT } from "../main.js";
import { VERSION } from "../version.js";
import pkg from "../../package.json";
import { html, startServer } from "../../../core/src/__tests__/helpers/server.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("parseCliArgs: unit", () => {
  it("parses a bare domain as the address", () => {
    expect(parseCliArgs(["example.com"])).toMatchObject({
      kind: "run",
      address: "https://example.com/",
    });
  });

  it("parses a full URL as the address", () => {
    expect(parseCliArgs(["http://example.com/menu?x=1"])).toMatchObject({
      kind: "run",
      address: "http://example.com/menu?x=1",
    });
  });

  it("--help prints usage and exits 0", async () => {
    const c = capture();
    expect(await main(["--help"], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain("Usage: gaugeline <address>");
    expect(c.err()).toBe("");
  });

  it("--version prints the package.json version", async () => {
    const c = capture();
    expect(await main(["--version"], c.io)).toBe(0);
    expect(c.out()).toBe(`${pkg.version}\n`);
    expect(VERSION).toBe(pkg.version);
  });

  it("an address prints the checking line and exits 0", async () => {
    const server = await startServer({ "/": html("<title>x</title>") });
    try {
      const c = capture();
      expect(await main([server.origin], c.io)).toBe(0);
      expect(c.out()).toBe(`Gaugeline ${pkg.version} checking ${server.origin}/\n`);
    } finally {
      await server.close();
    }
  });
});

describe("parseCliArgs: edge cases", () => {
  it("no address: usage on stderr, exit 2 (not 1: 1 is reserved for findings)", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(EXIT.couldNotRun);
    expect(EXIT.couldNotRun).toBe(2);
    expect(c.err()).toContain("No address given");
    expect(c.err()).toContain("gaugeline <address> [options]");
    expect(c.out()).toBe("");
  });

  it("unknown flag: named in the error, exit 2", async () => {
    const c = capture();
    expect(await main(["example.com", "--frobnicate"], c.io)).toBe(2);
    expect(c.err()).toContain("--frobnicate");
    expect(c.out()).toBe("");
  });

  it("address with trailing whitespace or a pasted newline is trimmed", () => {
    expect(parseCliArgs(["  example.com \n"])).toMatchObject({
      kind: "run",
      address: "https://example.com/",
    });
    expect(parseCliArgs(["https://example.com/\r\n"])).toMatchObject({
      kind: "run",
      address: "https://example.com/",
    });
  });

  it("an address that is only whitespace counts as no address", () => {
    expect(parseCliArgs([" \n"])).toMatchObject({ kind: "error", message: "No address given." });
  });

  it("two addresses are refused", () => {
    expect(parseCliArgs(["a.com", "b.com"])).toMatchObject({ kind: "error" });
  });

  it("a non-web scheme is refused with exit 2", async () => {
    const c = capture();
    expect(await main(["ftp://example.com"], c.io)).toBe(2);
    expect(c.err()).toContain("Only http and https");
  });
});
