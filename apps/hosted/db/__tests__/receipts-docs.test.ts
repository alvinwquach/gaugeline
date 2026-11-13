/**
 * docs/hosted/receipts.md: the example is real. Its SQL runs on a fresh database (the migrations, nothing
 * else), the owner's export is the file the page shows, and the command's offline check on that file prints
 * the page's output.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReceipts } from "../../../../packages/cli/src/receipts.js";
import { exportReceipts } from "../../lib/web/receipts.js";
import { as, freshDatabase, HAS_DATABASE, type TestDatabase } from "./harness.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/hosted/receipts.md"), "utf8").replace(/\r\n/g, "\n");
const block = (title: string): string =>
  new RegExp('```[a-z]+ title="' + title.replace(".", "\\.") + '"\n([\\s\\S]*?)```').exec(
    page,
  )?.[1] ?? "";

describe.skipIf(!HAS_DATABASE)("docs/hosted/receipts.md: the example is real output", () => {
  let db: TestDatabase;
  let dir: string;
  let exported = "";
  beforeAll(async () => {
    db = await freshDatabase();
    await db.sql.unsafe(block("example.sql")).simple();
    exported = await as(
      db.sql,
      { role: "authenticated", userId: "7b2e0000-0000-4000-8000-000000000001" },
      (tx) => exportReceipts(tx, "6a1f0000-0000-4000-8000-00000000c0de"),
    );
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-hosted-receipts-")));
  });
  afterAll(async () => {
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("the owner's export is the file the page shows", () => {
    expect(exported).not.toBe("");
    expect(exported).toBe(block("receipts.jsonl"));
  });

  it("gaugeline receipts verify on the export prints the page's output and passes", () => {
    expect(page).toContain("$ npx gaugeline receipts verify receipts.jsonl\n");
    writeFileSync(join(dir, "receipts.jsonl"), exported);
    const out: string[] = [];
    const outcome = runReceipts(
      { path: "receipts.jsonl", json: false },
      { stdout: { write: (s: string) => out.push(s) } },
      { cwd: dir },
    );
    expect(outcome).toEqual({ kind: "ran", highFindings: 0, drift: false });
    expect(out.join("")).toBe(block("Output"));
  });
});
