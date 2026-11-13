import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const FIX = fileURLToPath(new URL("../../../fixtures/approval-receipts/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/guides/verify-receipts.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const outputs = [...page.matchAll(/```text title="Output"\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => true },
      env: { NO_COLOR: "1" },
    },
    { cwd: FIX },
  );
  return { code, out: out.join("") };
}

describe("docs/guides/verify-receipts.md: the examples are real output on the pinned fixture", () => {
  it("the intact chain (the page's first command)", async () => {
    expect(page).toContain("$ npx gaugeline receipts verify pop-up-bar\n");
    const r = await run(["receipts", "verify", "pop-up-bar"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(outputs[0]);
  });

  it("the changed receipt (the page's second command)", async () => {
    expect(page).toContain("$ npx gaugeline receipts verify pop-up-bar-tampered\n");
    const r = await run(["receipts", "verify", "pop-up-bar-tampered"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe(outputs[1]);
  });

  it("--head with the head the first command printed (the page's third command)", async () => {
    const head = /^Head: ([0-9a-f]{64})$/m.exec(outputs[0] ?? "")?.[1] ?? "";
    expect(page).toContain(`$ npx gaugeline receipts verify pop-up-bar --head ${head}\n`);
    expect((await run(["receipts", "verify", "pop-up-bar", "--head", head])).code).toBe(0);
  });
});

describe("docs/guides/verify-receipts.md: what it promises", () => {
  it("says plainly it is tamper evidence, what the operator can do, and that anchoring is not built", () => {
    expect(page).toContain("This is tamper evidence, not a signature");
    expect(page).toMatch(/can rebuild\s+the whole chain/);
    expect(page).toMatch(/is a later\s+option; it is not built/);
    expect(page).toMatch(/no signatures, no keys and no\s+WebAuthn/);
    expect(page).toContain("RFC 8785");
  });

  it("names every check the verifier can report", async () => {
    const { APPROVAL_RECEIPT_CHECKS } = await import("@gaugeline/core");
    for (const c of APPROVAL_RECEIPT_CHECKS) expect(page, c).toContain(`| \`${c}\``);
  });
});
