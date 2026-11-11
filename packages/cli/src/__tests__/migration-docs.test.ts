import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { world } from "../../../core/src/migration/__tests__/world.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

/**
 * docs/guides/migration.md shows `npx gaugeline migration ...` twice, for the invented Wren Bakehouse. The
 * docs runner points a command at one fixture site and these read two (and a file), so this test runs the
 * page's own commands against recorded responses in a temporary folder holding the page's export, and
 * compares what the CLI prints with the blocks.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/migration.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

function examples(): Array<{ command: string; output: string }> {
  const all = fences();
  return all.flatMap((f, i) =>
    /title=Terminal/.test(f.info) && /^\$ npx gaugeline migration /.test(f.body)
      ? [{ command: f.body.replace(/^\$ npx gaugeline /, ""), output: all[i + 1]?.body ?? "" }]
      : [],
  );
}

describe("docs/guides/migration.md: the commands it shows", () => {
  it("has the two examples it describes", () => {
    expect(examples().map((e) => e.command)).toEqual([
      "migration preview.wrenbakehouse.example --old wrenbakehouse.example",
      "migration preview.wrenbakehouse.example --old-file wren-pages.csv",
    ]);
  });

  it("prints what the page says, for each", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-migration-docs-")));
    dirs.push(cwd);
    const csv = fences().find((f) => f.info.includes("title=wren-pages.csv"))?.body ?? "";
    expect(csv).toContain("/wholesale/");
    writeFileSync(join(cwd, "wren-pages.csv"), `${csv}\n`);
    for (const e of examples()) {
      const out: string[] = [];
      const code = await main(
        e.command.replace(/^migration /, "migration ").split(" "),
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => undefined },
          env: { NO_COLOR: "1" },
        },
        { cwd, fetcher: { transport: world().transport } },
      );
      expect(code, e.command).toBe(0);
      expect(out.join("").trimEnd().split("\n"), e.command).toEqual(e.output.split("\n"));
    }
  });

  it("the page names the flags, the sources, the exit codes and the privacy rules", () => {
    for (const word of [
      "--old",
      "--old-file",
      "--ci",
      "/wp-json/wp/v2/posts",
      "published only",
      "migration-page-missing",
      "migration-redirect-chain",
      "migration-title-changed",
      "migration-canonical-changed",
      "migration-schema-type-lost",
      "Exit codes",
      "is data",
    ])
      expect(page, word).toContain(word);
  });

  it("the page has an example from client work: a bakery moving to Next.js and Sanity", () => {
    expect(page).toContain("Wren Bakehouse");
    expect(page).toContain("Next.js");
    expect(page).toContain("Sanity");
  });

  it("every flag the command takes is on the page", () => {
    const own = flagsFor(FLAGS, "migration")
      .map((f) => f.name)
      .filter((n) => !["quiet", "verbose", "help", "version", "allow-private"].includes(n));
    for (const name of own) expect(page, `--${name}`).toContain(`--${name}`);
  });
});

describe("docs/options.md: gaugeline migration --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["migration", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.migration);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The migration command"));
  });
});
