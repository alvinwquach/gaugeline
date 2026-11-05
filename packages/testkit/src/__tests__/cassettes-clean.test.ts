import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCassetteDir } from "../cassette.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("cassettes are clean (promise test)", () => {
  it("every committed cassette is free of key-shaped strings, credential headers and non-read methods", () => {
    expect(scanCassetteDir()).toEqual([]);
  });

  it("a planted cassette with sk_live_ plus 24 characters fails and names the file and the JSON path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-cassettes-"));
    temps.push(dir);
    const key = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
    writeFileSync(
      join(dir, "planted.json"),
      JSON.stringify({
        version: 1,
        name: "planted",
        recordedAt: "2026-01-01T00:00:00.000Z",
        interactions: [
          {
            method: "POST",
            url: "https://api.example/",
            status: 200,
            headers: { authorization: "x" },
            body: `{"k":"${key}"}`,
          },
        ],
      }),
    );
    const problems = scanCassetteDir(dir);
    expect(problems).toEqual(
      expect.arrayContaining([
        {
          file: "planted.json",
          path: "$.interactions[0].body",
          reason: "matches key pattern stripe-secret",
        },
        {
          file: "planted.json",
          path: "$.interactions[0].headers.authorization",
          reason: "credential header authorization",
        },
        {
          file: "planted.json",
          path: "$.interactions[0].method",
          reason: "method POST is not GET or HEAD",
        },
      ]),
    );
  });
});
