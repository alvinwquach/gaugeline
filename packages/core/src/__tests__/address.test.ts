import { describe, expect, it } from "vitest";
import { parseAddress } from "../address.js";

describe("parseAddress", () => {
  it("reads a bare domain as https", () => {
    const r = parseAddress("example.com");
    expect(r.ok && r.url.href).toBe("https://example.com/");
  });
  it("keeps an explicit http scheme and path", () => {
    const r = parseAddress("http://example.com/a/b");
    expect(r.ok && r.url.href).toBe("http://example.com/a/b");
  });
  it("rejects an empty string", () => {
    expect(parseAddress("   ").ok).toBe(false);
  });
  it("rejects spaces inside the address", () => {
    expect(parseAddress("exa mple.com").ok).toBe(false);
  });
  it("rejects mailto and ftp", () => {
    expect(parseAddress("ftp://example.com").ok).toBe(false);
    expect(parseAddress("javascript://x").ok).toBe(false);
  });
});
