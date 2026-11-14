import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";
import { BAR_CONFIG, BAR_ENV, NOW, backupsWorld, barLister } from "./helpers/backups-world.js";

/**
 * docs/guides/backups.md shows `npx gaugeline backups ...` twice, once for each invented client. The docs
 * runner points every example at a fixture site and the first one also asks a platform API and a folder, so
 * this test runs the page's own commands against the recorded responses in core's
 * backups/__tests__/world.ts and compares the Output block with what the CLI prints. The "passed" lines
 * (a tick and a check id) are left out of the blocks, as the docs runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/backups.md", import.meta.url)),
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

function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline backups /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/guides/backups.md: the commands it shows", () => {
  it("has the two examples it describes, and the settings the tests use", () => {
    expect(examples().map((e) => e.command)).toEqual([
      "backups marlowe-bar.example",
      "backups ember-popup.example",
    ]);
    const settings = fences().find((f) => /title=gaugeline\.backups\.json/.test(f.info));
    expect(JSON.parse(settings?.body ?? "")).toEqual(BAR_CONFIG);
  });

  it("prints what the page says, for each client", async () => {
    for (const [i, e] of examples().entries()) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-backups-docs-")));
      dirs.push(dir);
      // The bar has its settings file and a Supabase token; the pop-up has neither.
      if (i === 0) writeFileSync(join(dir, "gaugeline.backups.json"), JSON.stringify(BAR_CONFIG));
      const w = backupsWorld();
      const out: string[] = [];
      const code = await main(
        [...e.command.split(/\s+/), "--no-open", "--quiet"],
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: () => undefined },
          env: i === 0 ? BAR_ENV : { NO_COLOR: "1" },
        },
        {
          cwd: dir,
          now: () => NOW,
          fetcher: { transport: w.transport },
          backups: { lister: barLister },
        } as never,
      );
      expect(code, e.command).toBe(EXIT.ok);
      const shown = out
        .join("")
        .split("\n")
        .filter((l) => !/^✓ [a-z0-9-]+$/.test(l))
        .join("\n");
      expect(shown.trimEnd(), `example ${i + 1}`).toBe(e.expected);
    }
  });

  it("the page names the checks, the settings file, the variables and the flags", () => {
    for (const word of [
      "no-recent-backup",
      "backups-not-enabled",
      "export-too-small",
      "gaugeline.backups.json",
      "SUPABASE_ACCESS_TOKEN",
      "SANITY_TOKEN",
      "--backups",
      "run --all --backups",
      "--ci",
      "--json",
    ])
      expect(page, word).toContain(word);
  });
});
