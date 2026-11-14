import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReceipt, receiptMarkdown, type ReceiptRun } from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const page = read("../../../../docs/guides/care-plan-receipt.md");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("docs/options.md: gaugeline receipt --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["receipt", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.receipt);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The receipt command"));
  });

  it("the flags --help lists are the flags the guide's options table lists", () => {
    const table = page.slice(page.indexOf("## Options"));
    for (const f of flagsFor(FLAGS, "receipt").filter(
      (f) => !["quiet", "verbose", "help", "version"].includes(f.name),
    ))
      expect(table, f.name).toContain(`--${f.name}`);
  });
});

describe("docs/guides/care-plan-receipt.md", () => {
  it("has the bar example, the money promise, and no money or traffic claim", () => {
    expect(page).toMatch(/Marlowe Bar is an invented client/);
    expect(page).toContain("never estimates money or traffic");
    expect(page.match(/^\$ npx gaugeline receipt /gm)?.length).toBeGreaterThanOrEqual(1);
    const claims = page.replace(/never estimates money or traffic saved\./, "");
    expect(claims).not.toMatch(/\b(saved you|revenue|profit|worth \$)|[\u20ac\u00a3]|\$\d/i);
  });

  it("the October output on the page is what the command prints from the fixture's runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-receipt-docs-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".gaugeline", "runs"), { recursive: true });
    cpSync(
      fileURLToPath(new URL("../../../fixtures/sites/receipt-bar-october/runs", import.meta.url)),
      join(cwd, ".gaugeline", "runs", "marlowe-bar.example"),
      { recursive: true },
    );
    const out: string[] = [];
    await main(
      ["receipt", "marlowe-bar.example", "--month", "2026-10"],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => 0 },
        env: { NO_COLOR: "1" },
        now: () => new Date("2026-11-03T09:00:00.000Z"),
      },
      { cwd },
    );
    expect(page).toContain(out.join("").trimEnd());
  });

  it("the quiet-month and coming-up blocks on the page are what the code writes", () => {
    const runs: ReceiptRun[] = Array.from({ length: 30 }, (_, i) => ({
      takenAt: `2026-09-${String(i + 1).padStart(2, "0")}T06:00:00.000Z`,
      pages: ["/"],
      findings: [],
    }));
    const quiet = receiptMarkdown(
      buildReceipt({
        site: "marlowe-bar.example",
        month: "2026-09",
        runs,
        now: new Date("2026-10-02T09:00:00.000Z"),
      }),
    ).trimEnd();
    expect(page).toContain(quiet);
    const coming = receiptMarkdown(
      buildReceipt({
        site: "marlowe-bar.example",
        month: "2026-10",
        runs: [],
        renewals: [
          { kind: "domain", subject: "marlowe-bar.example", date: "2026-12-20T00:00:00.000Z" },
        ],
        now: new Date("2026-11-13T09:00:00.000Z"),
      }),
    );
    expect(coming).toContain(
      "## Coming up\n\n- Domain marlowe-bar.example: expires 20 Dec 2026, 36 days.",
    );
    expect(page).toContain(
      "## Coming up\n\n- Domain marlowe-bar.example: expires 20 Dec 2026, 36 days.",
    );
  });
});
