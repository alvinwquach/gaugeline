import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { BAR_SERVICES, audit, folder, removeFolders } from "./helpers/audit-world.js";
import { runBin } from "./helpers/bin.js";

/**
 * docs/guides/audit-pack.md shows `npx gaugeline audit ... --pack` twice, once for each invented client.
 * The docs runner cannot supply the page's gaugeline.services.json and the command writes a folder, so
 * this test runs the page's own commands against the corner-bar and clean fixtures in a temporary folder
 * holding the page's settings, and compares what the CLI prints and what it writes with the blocks.
 * The fixture's own address is written as the client's, as the docs runner does.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/audit-pack.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

afterEach(removeFolders);

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

const block = (title: string, nth = 0): string =>
  fences().filter((f) => f.info.includes(`title=${title}`))[nth]?.body ?? "";

/** Each example: the command, the terminal Output block after it, and the audit-pack.md block after that. */
function examples(): Array<{ command: string; output: string; pack: string }> {
  const all = fences();
  const out: Array<{ command: string; output: string; pack: string }> = [];
  all.forEach((f, i) => {
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline audit /.test(f.body)) return;
    out.push({
      command: f.body.replace(/^\$ npx gaugeline /, ""),
      output: all[i + 1]?.body ?? "",
      pack: all[i + 2]?.body ?? "",
    });
  });
  return out;
}

describe("docs/guides/audit-pack.md: the commands it shows", () => {
  it("has the two examples it describes, and settings that are the ones the tests use", () => {
    expect(examples().map((e) => e.command)).toEqual([
      'audit cornerbar.example --pack --business "The Corner Bar"',
      'audit juniperbakehouse.example --pack --business "Juniper Bakehouse"',
    ]);
    expect(JSON.parse(block("gaugeline.services.json"))).toEqual(BAR_SERVICES);
  });

  it("prints and writes what the page says, for each client", async () => {
    const fixtures = ["corner-bar", "clean"];
    for (const [i, e] of examples().entries()) {
      const cwd = folder();
      writeFileSync(join(cwd, "gaugeline.services.json"), block("gaugeline.services.json"));
      const business = /--business "([^"]+)"/.exec(e.command)?.[1] ?? "";
      const host = /^audit (\S+)/.exec(e.command)?.[1] ?? "";
      const r = await audit(fixtures[i] ?? "", ["--pack", "--business", business], cwd);
      expect(r.code, e.command).toBe(0);
      const shown = (text: string): string =>
        text.replaceAll(r.origin, `https://${host}`).replaceAll("127.0.0.1", host);
      expect(shown(r.out).trimEnd().split("\n")).toEqual(e.output.split("\n"));
      const written = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
      expect(shown(written).trimEnd().split("\n"), `pack ${i + 1}`).toEqual(e.pack.split("\n"));
    }
  });

  it("the page names the settings file, the flags, the exit codes and the probing rule", () => {
    for (const word of [
      "gaugeline.services.json",
      "gaugeline.consent.json",
      "--pack",
      "--business",
      "--brand",
      "--brand-logo",
      "--brand-contact",
      "--out",
      "--force",
      "--dns",
      "--owner-consent",
      "covers.checks",
      "covers.areas",
      "notIncluded",
      "Run them only on sites you own or have permission to test",
      "Other findings",
    ])
      expect(page, word).toContain(word);
  });

  it("the flag table on the page lists every flag the command takes", () => {
    const own = flagsFor(FLAGS, "audit")
      .map((f) => f.name)
      .filter(
        (n) =>
          !["quiet", "verbose", "help", "version", "allow-private", "allow-secret-key"].includes(n),
      );
    for (const name of own) expect(page, `--${name}`).toContain(`--${name}`);
  });

  it("the page has examples from client work: a bar and a bakery", () => {
    expect(page).toContain("The Corner Bar");
    expect(page).toContain("Juniper Bakehouse");
  });
});

describe("docs/options.md: gaugeline audit --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["audit", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.audit);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The audit command"));
  });
});
