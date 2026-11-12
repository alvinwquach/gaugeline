import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtInCheckIds } from "../builtin-ids.js";

describe("builtInCheckIds", () => {
  it("holds every id in docs/check-ids.lock.json, so a custom check can take none of them", () => {
    const lock = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../docs/check-ids.lock.json", import.meta.url)),
        "utf8",
      ),
    ) as string[];
    const ids = builtInCheckIds();
    expect(lock.filter((id) => !ids.has(id))).toEqual([]);
  });
});
