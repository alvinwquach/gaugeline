import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const FIX = fileURLToPath(new URL("../../../fixtures/approval-receipts/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");
const HEAD = "f438d8ae13da0ebfa26467a2fe058893bf55f65d2a67e4a979c1bc6292952928";
const SECOND = "27cba304c01ead8f281e84f28b3749f4fb1abe4b98ab9c269c120aa79e50baf1";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-receipts-")));
  cpSync(FIX, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const fetches: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    {
      cwd: dir,
      // Offline: any request at all fails the test.
      fetcher: new Proxy({} as never, {
        get: (_t, p) => () => {
          fetches.push(String(p));
          throw new Error("no request may be made");
        },
      }),
    },
  );
  expect(fetches).toEqual([]);
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline receipts verify: a chain that checks out (exit 0)", () => {
  it("a folder: the chain and the payloads beside it", async () => {
    const r = await run(["receipts", "verify", "pop-up-bar"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 receipts");
    expect(r.out).toContain("2 payloads");
    expect(r.out).toContain(HEAD);
    expect(r.out).toMatch(/not a signature/i);
  });

  it("the chain file alone", async () => {
    const r = await run(["receipts", "verify", "pop-up-bar/receipts.jsonl"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 receipts");
  });

  it("--head with a head written down earlier that is still in the chain", async () => {
    expect((await run(["receipts", "verify", "pop-up-bar", "--head", SECOND])).code).toBe(0);
  });

  it("--json prints the verdict and nothing else", async () => {
    const r = await run(["receipts", "verify", "pop-up-bar", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      receipts: 4,
      verified: 4,
      payloads: 2,
      org: "6a1f0000-0000-4000-8000-00000000c0de",
      head: HEAD,
    });
  });

  it("an empty chain file is an empty chain", async () => {
    writeFileSync(join(dir, "empty.jsonl"), "");
    const r = await run(["receipts", "verify", "empty.jsonl"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no receipts");
  });
});

describe("gaugeline receipts verify: a broken chain (exit 1) names the first broken receipt", () => {
  it("the failing fixture: a role changed in receipt 2", async () => {
    const r = await run(["receipts", "verify", "pop-up-bar-tampered"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("receipt 2 (line 2)");
    expect(r.out).toContain("hash");
    expect(r.out).toContain("1 receipt before it checks out");
  });

  it("--json: the problem's index, line, check and message", async () => {
    const r = await run(["receipts", "verify", "pop-up-bar-tampered", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      receipts: 4,
      verified: 1,
      problem: { index: 1, line: 2, check: "hash" },
    });
  });

  it("a removed receipt, and a reordered one", async () => {
    const file = join(dir, "pop-up-bar", "receipts.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    expect(JSON.parse((await run(["receipts", "verify", file, "--json"])).out)).toMatchObject({
      problem: { index: 1, check: "sequence" },
    });
    writeFileSync(file, [lines[0], lines[2], lines[1], lines[3]].join("\n") + "\n");
    const r = await run(["receipts", "verify", file]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("receipt 2 (line 2)");
  });

  it("a swapped payload beside the chain, never printing the payload", async () => {
    writeFileSync(
      join(dir, "pop-up-bar", "payloads", "8c3d0000-0000-4000-8000-000000000001.txt"),
      '{"body": "secret-looking-text", "files": [], "title": "x"}',
    );
    const r = await run(["receipts", "verify", "pop-up-bar"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("payload");
    expect(r.out + r.err).not.toContain("secret-looking-text");
  });

  it("a cut-off end, found with --head", async () => {
    const file = join(dir, "pop-up-bar", "receipts.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, lines.slice(0, 3).join("\n") + "\n");
    expect((await run(["receipts", "verify", "pop-up-bar"])).code).toBe(0);
    const r = await run(["receipts", "verify", "pop-up-bar", "--head", HEAD]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("head");
  });
});

describe("gaugeline receipts verify: could not read (exit 2)", () => {
  it("a path that is not there", async () => {
    const r = await run(["receipts", "verify", "nowhere.jsonl"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nowhere.jsonl");
  });

  it("a folder without receipts.jsonl", async () => {
    mkdirSync(join(dir, "bare"));
    const r = await run(["receipts", "verify", "bare"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("receipts.jsonl");
  });

  it("a payloads folder with a file that is not <draft id>.txt", async () => {
    writeFileSync(join(dir, "pop-up-bar", "payloads", "notes.md"), "x");
    const r = await run(["receipts", "verify", "pop-up-bar"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("notes.md");
  });

  it("a chain file that is not UTF-8", async () => {
    writeFileSync(join(dir, "latin1.jsonl"), Buffer.from([0x7b, 0xe9, 0x7d, 0x0a]));
    const r = await run(["receipts", "verify", "latin1.jsonl"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/UTF-8/);
  });

  it("no action, an unknown action, no path, two paths", async () => {
    for (const argv of [
      ["receipts"],
      ["receipts", "sign", "x.jsonl"],
      ["receipts", "verify"],
      ["receipts", "verify", "a.jsonl", "b.jsonl"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain("gaugeline receipts verify");
    }
  });

  it("a flag the command does not take", async () => {
    expect((await run(["receipts", "verify", "pop-up-bar", "--allow-private"])).code).toBe(2);
  });
});

describe("gaugeline receipts --help and docs/options.md", () => {
  it("prints the help the options page shows, and every flag of the command is in both", async () => {
    const r = await runBin(["receipts", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.receipts);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The receipts command"));
    for (const f of flagsFor(FLAGS, "receipts")) {
      expect(HELP.receipts, `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
  });

  it("is not the care-plan receipt: gaugeline receipt keeps its own help", () => {
    expect(HELP.receipt).toContain("gaugeline receipt <site>");
    expect(HELP.receipts).toContain("gaugeline receipts verify <file|folder>");
  });
});
