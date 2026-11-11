import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";
import { BAR_CONFIG, ENV, NOW, world } from "./helpers/renewals-world.js";

/**
 * docs/guides/renewals.md shows `npx gaugeline renewals ...` twice, once for each invented client. The
 * docs runner points every example at a fixture site and these ask a domain registry and two token
 * APIs, so this test runs the page's own commands against the recorded responses in
 * helpers/renewals-world.ts and compares the Output block with what the CLI prints. The "passed" lines
 * (a tick and a check id) are left out of the blocks, as the docs runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/renewals.md", import.meta.url)),
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
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline renewals /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/guides/renewals.md: the commands it shows", () => {
  it("has the two examples it describes", () => {
    expect(examples().map((e) => e.command)).toEqual([
      "renewals marlowe-bar.com",
      "renewals cedar-clinic.co.uk",
    ]);
  });

  it("prints what the page says, for each client", async () => {
    for (const [i, e] of examples().entries()) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-renewals-docs-")));
      dirs.push(dir);
      // The bar's project is named in gaugeline.renewals.json and its tokens are in the environment;
      // the clinic has neither.
      if (i === 0) writeFileSync(join(dir, "gaugeline.renewals.json"), BAR_CONFIG);
      const out: string[] = [];
      const err: string[] = [];
      const { transport } = world();
      const code = await main(
        [...e.command.split(/\s+/), "--no-open"],
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: i === 0 ? ENV : { NO_COLOR: "1" },
        },
        { cwd: dir, now: () => NOW, fetcher: { transport } } as never,
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

  it("the page names the checks, the settings file, the variables and the flag", () => {
    for (const word of [
      "domain-expires-soon",
      "domain-expired",
      "domain-status-hold",
      "certificate-expiring",
      "cert-name-mismatch",
      "token-expires-soon",
      "runtime-deprecated",
      "gaugeline.renewals.json",
      "GAUGELINE_GITHUB_TOKEN",
      "GAUGELINE_VERCEL_TOKEN",
      "--renewals",
      "run --all",
    ])
      expect(page, word).toContain(word);
  });
});
