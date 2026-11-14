import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BAR_CONFIG,
  CHARGES_URL_TEAM,
  ENV,
  JUMPED,
  NOW,
  POPUP,
  world,
} from "../../../core/src/cost/__tests__/world.js";
import { EXIT, main } from "../main.js";

/**
 * docs/guides/hosting-cost.md shows `npx gaugeline cost ...` twice, once for each invented client. The docs
 * runner points every example at a fixture site and the first one also asks a usage API, so this test
 * runs the page's own commands against the recorded responses in core's cost/__tests__/world.ts and
 * compares the Output block with what the CLI prints. The "passed" lines (a tick and a check id) are left
 * out of the blocks, as the docs runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/hosting-cost.md", import.meta.url)),
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
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline cost /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/guides/hosting-cost.md: the commands it shows", () => {
  it("has the two examples it describes, and the settings the tests use", () => {
    expect(examples().map((e) => e.command)).toEqual([
      "cost marlowe-bar.example",
      "cost ember-popup.example",
    ]);
    const settings = fences().find((f) => /title=gaugeline\.cost\.json/.test(f.info));
    expect(JSON.parse(settings?.body ?? "")).toEqual(BAR_CONFIG);
  });

  it("prints what the page says, for each client", async () => {
    for (const [i, e] of examples().entries()) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-cost-docs-")));
      dirs.push(dir);
      // The bar has its settings file and a Vercel token; the pop-up has neither settings nor a token.
      if (i === 0) writeFileSync(join(dir, "gaugeline.cost.json"), JSON.stringify(BAR_CONFIG));
      const w =
        i === 0
          ? world({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } } })
          : world(POPUP);
      const out: string[] = [];
      const code = await main(
        [...e.command.split(/\s+/), "--no-open", "--quiet"],
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: () => undefined },
          env: i === 0 ? ENV : { NO_COLOR: "1" },
        },
        {
          cwd: dir,
          now: () => NOW,
          fetcher: { transport: w.transport },
          cost: { sleep: async () => undefined },
        } as never,
      );
      expect(code, e.command).toBe(EXIT.ok);
      const shown = out
        .join("")
        .split("\n")
        .filter((l) => !/^\u2713 [a-z0-9-]+$/.test(l))
        .join("\n");
      expect(shown.trimEnd(), `example ${i + 1}`).toBe(e.expected);
    }
  });

  it("the page names the checks, the settings file, the variables and the flags", () => {
    for (const word of [
      "output-changes-every-request",
      "never-cached",
      "revalidate-too-often",
      "usage-jump",
      "gaugeline.cost.json",
      "GAUGELINE_VERCEL_TOKEN",
      "SANITY_TOKEN",
      "--cost",
      "run --all --cost",
      "--ci",
      "--json",
    ])
      expect(page, word).toContain(word);
  });
});
