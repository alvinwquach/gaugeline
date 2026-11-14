import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const FIX = fileURLToPath(new URL("../../../fixtures/advisories/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/check-writer.md"), "utf8").replace(/\r\n/g, "\n");
const outputs = [...page.matchAll(/```text title="Output"\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-write-check-docs-")));
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

describe("docs/check-writer.md: the examples are real output on the pinned fixture", () => {
  it("the passing run (the page's first command)", async () => {
    const cmd =
      "$ npx gaugeline write-check --from-file golden/advisory-kiln-forms.md --deny-list deny-list.txt\n";
    expect(page).toContain(cmd);
    const r = await run([
      "write-check",
      "--from-file",
      "golden/advisory-kiln-forms.md",
      "--deny-list",
      "deny-list.txt",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(outputs[0]);
  });

  it("the refused run (the page's second command): the kind and the line, no draft", async () => {
    const cmd =
      "$ npx gaugeline write-check --from-file leaky-name/advisory-leak-name.md --deny-list deny-list.txt\n";
    expect(page).toContain(cmd);
    const r = await run([
      "write-check",
      "--from-file",
      "leaky-name/advisory-leak-name.md",
      "--deny-list",
      "deny-list.txt",
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toBe(outputs[1]);
  });

  it("the page that is not understood (the page's third command)", async () => {
    const cmd = "$ npx gaugeline write-check --from-file not-understood/release-notes.md\n";
    expect(page).toContain(cmd);
    const r = await run(["write-check", "--from-file", "not-understood/release-notes.md"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe(outputs[2]);
  });
});

describe("docs/check-writer.md: what it promises", () => {
  it("says it is a draft, edits nothing, fetches nothing, and cites every claim", () => {
    expect(page).toMatch(/DRAFT/);
    expect(page).toMatch(/does not call a model/i);
    expect(page).toMatch(/never fetch/i);
    expect(page).toMatch(/edits? no registry/i);
    expect(page).toMatch(/cited line/i);
  });
});
