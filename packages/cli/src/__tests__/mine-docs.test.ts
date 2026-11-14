import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const FIX = fileURLToPath(new URL("../../../fixtures/field-notes/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/field-findings-miner.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const outputs = [...page.matchAll(/```text title="Output"\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-mine-docs-")));
  cpSync(FIX, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => true },
      env: { NO_COLOR: "1" },
    },
    { cwd: dir },
  );
  return { code, out: out.join("") };
}

describe("docs/field-findings-miner.md: the examples are real output on the pinned fixture", () => {
  it("the passing run (the page's first command)", async () => {
    expect(page).toContain(
      "$ npx gaugeline mine --review-notes golden --deny-list deny-list.txt\n",
    );
    const r = await run(["mine", "--review-notes", "golden", "--deny-list", "deny-list.txt"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(outputs[0]);
  });

  it("the failing run (the page's second command): the kind and the line, no draft", async () => {
    expect(page).toContain(
      "$ npx gaugeline mine --review-notes leaky-name --deny-list deny-list.txt\n",
    );
    const r = await run(["mine", "--review-notes", "leaky-name", "--deny-list", "deny-list.txt"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe(outputs[1]);
  });
});

describe("docs/field-findings-miner.md: what it promises", () => {
  it("says it is a draft, read-only for sites, with no model and no key", () => {
    expect(page).toMatch(/DRAFT/);
    expect(page).toMatch(/does not call a model/i);
    expect(page).toMatch(/never (prints|echoes)/i);
  });
});
