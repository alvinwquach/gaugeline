import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import type { Transport } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-printed-"));
  dirs.push(dir);
  cpSync(join(FIXTURES, "printed", "register.csv"), join(dir, "register.csv"));
  return dir;
}

/** Every address answers 200 with a page: for runs that only need the decoding. */
const open200: Transport = async () => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: Readable.from([Buffer.from("<title>A page</title>")]),
});

describe("gaugeline printed: e2e (CLI)", () => {
  it("the Copper Kettle register: prints the guide's Output block and exits 1", async () => {
    const site = await startFixture("printed-links");
    try {
      const dir = workdir();
      const run = capture();
      expect(
        await main(["printed", "register.csv"], run.io, {
          cwd: dir,
          fetcher: { hosts: site.hosts },
        }),
      ).toBe(1);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("guides/printed-links", "Checking the register"),
      );
    } finally {
      await site.close();
    }
  });

  it("--decode reads the QR images, adds the new addresses to the register, and names the unreadable one", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "printed.csv"), "url,where\n");
    cpSync(join(FIXTURES, "qr"), join(dir, "flyers"), { recursive: true });
    const run = capture();
    // The shell expands --decode flyers/*.png: one value, then more positionals.
    const code = await main(
      [
        "printed",
        "printed.csv",
        "--decode",
        "flyers/blurred-flyer.png",
        "flyers/spring-flyer.png",
        "flyers/table-tent.png",
      ],
      run.io,
      { cwd: dir, fetcher: { transport: open200 } },
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "printed.csv"), "utf8")).toBe(
      "url,where\nhttps://copperkettle.example/spring-flyer,spring-flyer.png\nhttps://copperkettle.example/table-menu?utm_source=table-tent&utm_medium=qr,table-tent.png\n",
    );
    expect(run.err()).toContain("Read 2 QR codes from 3 images; added 2 to printed.csv");
    expect(run.out()).toContain(
      "? blurred-flyer.png could not be checked: no QR code could be read (blurred, too small, or not there)",
    );
    // A second decode adds nothing: the register already has both.
    const again = capture();
    await main(["printed", "printed.csv", "--decode", "flyers"], again.io, {
      cwd: dir,
      fetcher: { transport: open200 },
    });
    expect(again.err()).toContain("the register already had every address");
  });

  it("a register with no url column, or none at all: exit 2", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "bad.csv"), "where,date\nflyer,2026\n");
    const run = capture();
    expect(await main(["printed", "bad.csv"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("The printed register has no url column.");
    expect(await main(["printed"], capture().io, { cwd: dir })).toBe(2);
  });
});

describe("gaugeline plan --printed: the register feeds the 301 map", () => {
  it("a printed address whose page moves is checked as an old address before launch", async () => {
    const site = await startFixture("plan-redirects");
    try {
      const dir = mkdtempSync(join(tmpdir(), "gaugeline-plan-printed-"));
      dirs.push(dir);
      cpSync(join(SITES_DIR, "plan-redirects", "plan.csv"), join(dir, "plan.csv"));
      writeFileSync(
        join(dir, "printed.csv"),
        "url,where,expectedDestination\nhttps://lanternbooks.example/kids-qr,bookmarks,https://lanternbooks.example/kids\nhttps://lanternbooks.example/fiction,posters,\nhttps://lanternbooks.example/zines,zine fair,https://lanternbooks.example/zines\n",
      );
      const run = capture();
      expect(
        await main(
          [
            "plan",
            "plan.csv",
            "--base",
            site.origin,
            "--allow-private",
            "--printed",
            "printed.csv",
          ],
          run.io,
          { cwd: dir },
        ),
      ).toBe(1);
      expect(run.out()).toContain("/kids-qr returns 404: nothing redirects it");
      expect(run.err()).toContain(
        "1 printed address has no planned page to land on: give it an expectedDestination in printed.csv.",
      );
      expect(run.err()).toContain("Reading 9 old addresses from the Legacy URL column");
      const without = capture();
      expect(
        await main(["plan", "plan.csv", "--printed", "printed.csv"], without.io, { cwd: dir }),
      ).toBe(2);
      expect(without.err()).toContain(
        "--printed checks printed addresses on a preview: add --base.",
      );
    } finally {
      await site.close();
    }
  });
});
