import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";
import {
  BAR_HANDOFF,
  BAR_LISTINGS,
  COACH_HANDOFF,
  ENV,
  NOW,
  world,
} from "./helpers/handoff-world.js";

/**
 * docs/guides/handoff.md shows `npx gaugeline handoff ...` twice, once for each invented client. The docs
 * runner points every example at a fixture site and these ask a registry and three provider APIs, so
 * this test runs the page's own commands against the recorded responses in
 * core/src/handoff/__tests__/world.ts, in a folder holding the page's own settings files, and compares
 * the Output block with what the CLI prints. The "passed" lines (a tick and a check id) are left out of
 * the blocks, as the docs runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/handoff.md", import.meta.url)),
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

/** Each example: the settings files shown just before its command, the command, and its Output block. */
function examples(): Array<{
  command: string;
  expected: string;
  files: Record<string, string>;
}> {
  const all = fences();
  const out: Array<{ command: string; expected: string; files: Record<string, string> }> = [];
  let files: Record<string, string> = {};
  all.forEach((f, i) => {
    const file = /title=(gaugeline\.[a-z]+\.json)/.exec(f.info);
    if (file?.[1] === "gaugeline.handoff.json") files = { [file[1]]: f.body };
    else if (file?.[1]) files = { ...files, [file[1]]: f.body };
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline handoff /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body, files });
  });
  return out;
}

describe("docs/guides/handoff.md: the commands it shows", () => {
  it("has the two examples it describes, and settings that are the ones the tests use", () => {
    const ex = examples();
    expect(ex.map((e) => e.command)).toEqual([
      "handoff marlowe-bar.com",
      "handoff juniper-coaching.com",
    ]);
    expect(JSON.parse(ex[0]?.files["gaugeline.handoff.json"] ?? "")).toEqual(BAR_HANDOFF);
    expect(JSON.parse(ex[0]?.files["gaugeline.listings.json"] ?? "")).toEqual(BAR_LISTINGS);
    expect(JSON.parse(ex[1]?.files["gaugeline.handoff.json"] ?? "")).toEqual(COACH_HANDOFF);
  });

  it("prints what the page says, for each client", async () => {
    for (const [i, e] of examples().entries()) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-handoff-docs-")));
      dirs.push(dir);
      for (const [name, body] of Object.entries(e.files)) writeFileSync(join(dir, name), body);
      const out: string[] = [];
      const { transport } = world();
      const code = await main(
        [...e.command.split(/\s+/), "--quiet"],
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: () => undefined },
          env: i === 0 ? ENV : { ...ENV, SANITY_PROJECT_ID: undefined },
        },
        { cwd: dir, now: () => NOW, fetcher: { transport } } as never,
      );
      expect(code, e.command).toBe(EXIT.ok);
      const shown = out
        .join("")
        .split("\n")
        .filter((l) => !/^✓ /.test(l))
        .join("\n");
      expect(shown.trimEnd(), `example ${i + 1}`).toBe(e.expected);
      if (i === 0) {
        // The end of handoff.md, as the page shows it, is the end of the file the command wrote.
        const shownEnd = fences().find((f) => /title=handoff\.md/.test(f.info))?.body ?? "";
        const written = readFileSync(join(dir, "gaugeline-handoff", "handoff.md"), "utf8");
        const tail = written.slice(written.indexOf("## A checklist for the owner"));
        expect(tail.trimEnd().split("\n")).toEqual(shownEnd.split("\n"));
      }
    }
  });

  it("the page names the checks, the settings file, the variables and the flags", () => {
    for (const word of [
      "client-not-admin",
      "single-admin",
      "personal-account",
      "gaugeline.handoff.json",
      "gaugeline.listings.json",
      "GAUGELINE_VERCEL_TOKEN",
      "SANITY_TOKEN",
      "GOOGLE_BUSINESS_PROFILE_TOKEN",
      "--out",
      "--force",
      "--json",
      "--dns",
      "--ci",
      "sameAs",
      "members()",
    ])
      expect(page, word).toContain(word);
  });
});
