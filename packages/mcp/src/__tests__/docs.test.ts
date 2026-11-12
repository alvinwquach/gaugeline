import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../registry.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/mcp.md", import.meta.url)),
  "utf8",
);

describe("docs/mcp.md", () => {
  it("lists every tool in the registry with its kind, and no other tool", () => {
    const rows = [...page.matchAll(/^\| `([a-z_]+)`\s+\| `(read|draft)`/gm)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(Object.fromEntries(rows)).toEqual(
      Object.fromEntries(Object.entries(TOOLS).map(([n, d]) => [n, d.kind])),
    );
  });

  it("is no longer marked as not released", () => {
    expect(page).not.toMatch(/notReleased/);
  });
});
