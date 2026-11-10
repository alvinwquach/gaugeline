import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { EXIT, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

let site: Fixture;
beforeAll(async () => {
  site = await startFixture("ad-redirects");
});
afterAll(async () => {
  await site.close();
});

const tags = (args: string[]) => {
  const c = capture();
  return main(["tags", ...args, "--allow-private"], c.io).then((code) => ({ code, c }));
};

describe("gaugeline tags: arguments", () => {
  it("takes one address, and --ci, --allow-private and --quiet", () => {
    expect(parseCliArgs(["tags", "shop.example/go?utm_source=x"])).toMatchObject({
      kind: "tags",
      address: "shop.example/go?utm_source=x",
      ci: false,
      allowPrivate: false,
    });
    expect(parseCliArgs(["tags", "shop.example", "--ci", "--allow-private"])).toMatchObject({
      ci: true,
      allowPrivate: true,
    });
  });

  it("no address, or two, is a usage error that shows the fix", () => {
    for (const argv of [["tags"], ["tags", "a.example", "b.example"]])
      expect(parseCliArgs(argv), argv.join(" ")).toMatchObject({
        kind: "error",
        message: expect.stringContaining("gaugeline tags needs one link"),
      });
  });

  it("is a command of the flags it uses, in the table the docs and --help are made from", () => {
    for (const name of ["ci", "allow-private"])
      expect(FLAGS.find((f) => f.name === name)?.commands, name).toContain("tags");
    expect(parseCliArgs(["tags", "a.example", "--json"])).toMatchObject({ kind: "error" });
  });

  it("--help lists the command and its limit", async () => {
    const c = capture();
    expect(await main(["tags", "--help"], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain("gaugeline tags <link>");
    expect(c.out().replace(/\s+/g, " ")).toContain("does not run the page's JavaScript");
  });
});

describe("gaugeline tags: e2e", () => {
  it("prints two hops and 'lost at hop 1' for a 301 that drops the query", async () => {
    const { code, c } = await tags([`${site.origin}/go?utm_source=x`]);
    expect(code).toBe(EXIT.ok);
    const lines = c.out().trimEnd().split("\n");
    expect(lines.filter((l) => l.startsWith("hop "))).toEqual([
      `hop 1  301  ${site.origin}/go?utm_source=x  tags: utm_source`,
      `hop 2  200  ${site.origin}/landing  tags: none`,
    ]);
    expect(c.out()).toContain("lost at hop 1");
    expect(c.out()).toContain("dropped utm_source");
  });

  it("always says what it does not see: a script that rewrites the address after load", async () => {
    const { c } = await tags([`${site.origin}/go?utm_source=x`]);
    expect(c.out()).toMatch(/follows redirects only/i);
    expect(c.out()).toMatch(/JavaScript/);
  });

  it("exit codes as in the page check: 0 by default, 1 with --ci when tags are lost, 2 when it could not run", async () => {
    const lost = await tags([`${site.origin}/go?utm_source=x`, "--ci"]);
    expect(lost.code).toBe(EXIT.findings);
    const kept = await tags([
      `${site.origin}/go-keeps?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu`,
      "--ci",
    ]);
    expect(kept.code).toBe(EXIT.ok);
    expect(kept.c.out()).toContain("Campaign tags kept");
    const down = await main(
      ["tags", "http://127.0.0.1:1/x?utm_source=x", "--allow-private"],
      capture().io,
    );
    expect(down).toBe(EXIT.couldNotRun);
  });

  it("a link with no tags is followed with Gaugeline's own and says so", async () => {
    const { code, c } = await tags([`${site.origin}/go`]);
    expect(code).toBe(EXIT.ok);
    expect(c.out()).toContain("utm_source=gaugeline-check");
    expect(c.out()).toMatch(/Gaugeline's own/);
    expect(c.out()).toContain("lost at hop 1");
  });

  it("a link that keeps its tags through no redirect at all passes with one hop", async () => {
    const { code, c } = await tags([`${site.origin}/landing?utm_source=x&gclid=y`]);
    expect(code).toBe(EXIT.ok);
    expect(
      c
        .out()
        .split("\n")
        .filter((l) => l.startsWith("hop ")),
    ).toHaveLength(1);
    expect(c.out()).toContain("Campaign tags kept: utm_source, gclid arrived (no redirect).");
  });

  it("a redirect that moves the tag into the fragment is lost, with the note", async () => {
    const { c } = await tags([`${site.origin}/go-fragment?utm_source=facebook`]);
    expect(c.out()).toContain("lost at hop 1");
    expect(c.out()).toContain("servers never see");
  });

  it("the final page answering 404 still gets its tag verdict", async () => {
    const { code, c } = await tags([`${site.origin}/gone?utm_source=x`]);
    expect(code).toBe(EXIT.ok);
    expect(c.out()).toContain("Campaign tags kept");
    expect(c.out()).toContain("answered 404");
  });

  it("a redirect loop that kept its tags is exit 2 with the reason, after the hops it saw", async () => {
    const { code, c } = await tags([`${site.origin}/loop-a?utm_source=facebook`]);
    expect(code).toBe(EXIT.couldNotRun);
    expect(c.out()).toContain("hop 1");
    expect(c.out()).toMatch(/redirects in a loop/);
  });

  it("sends only GET requests, one per hop", async () => {
    const before = site.total;
    await tags([`${site.origin}/chain?utm_source=facebook&utm_medium=paid`]);
    expect(site.total - before).toBe(3);
    expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  });

  it("an address on this computer is refused without --allow-private", async () => {
    const c = capture();
    expect(await main(["tags", `${site.origin}/go?utm_source=x`], c.io)).toBe(EXIT.couldNotRun);
    expect(c.out()).not.toContain("hop 1");
  });

  it("the built bin: prints the trail and exits 0, and 1 with --ci", async () => {
    const ok = await runBin(["tags", `${site.origin}/go?utm_source=x`]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("lost at hop 1");
    const ci = await runBin(["tags", `${site.origin}/go?utm_source=x`, "--ci"]);
    expect(ci.status).toBe(1);
  });
});
