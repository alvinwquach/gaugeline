import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_DEFAULT_OUT, parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";
import { BAR_SERVICES, audit, folder, removeFolders } from "./helpers/audit-world.js";

afterEach(removeFolders);

const parsed = (argv: string[]) => parseCliArgs(argv);
const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l !== "");

function withServices(cwd: string, config: unknown = BAR_SERVICES): void {
  writeFileSync(join(cwd, "gaugeline.services.json"), JSON.stringify(config, null, 2));
}

describe("audit: arguments", () => {
  it("reads the address, --pack, the business, the brand and the folder", () => {
    const a = parsed([
      "audit",
      "marlowe-bar.test",
      "--pack",
      "--business",
      "Marlowe Bar",
      "--brand",
      "Harbour Studio",
      "--brand-logo",
      "https://harbour-studio.example/logo.png",
      "--brand-contact",
      "Mia, 555 0142",
      "--out",
      "proposal",
      "--force",
    ]);
    expect(a).toMatchObject({
      kind: "run",
      command: "audit",
      address: "https://marlowe-bar.test/",
      audit: {
        business: "Marlowe Bar",
        brand: {
          name: "Harbour Studio",
          logoUrl: "https://harbour-studio.example/logo.png",
          contact: "Mia, 555 0142",
        },
        out: "proposal",
        force: true,
      },
    });
  });

  it("every flag but --pack is optional, and the folder defaults to gaugeline-audit", () => {
    const a = parsed(["audit", "marlowe-bar.test", "--pack"]);
    expect(a).toMatchObject({
      kind: "run",
      command: "audit",
      audit: { brand: {}, out: AUDIT_DEFAULT_OUT, force: false },
    });
    expect(AUDIT_DEFAULT_OUT).toBe("gaugeline-audit");
  });

  it("needs --pack, and says what it does", () => {
    const a = parsed(["audit", "marlowe-bar.test"]);
    expect(a.kind).toBe("error");
    if (a.kind === "error") expect(a.message).toMatch(/needs --pack/);
  });

  it("needs exactly one address", () => {
    for (const argv of [
      ["audit", "--pack"],
      ["audit", "a.test", "b.test", "--pack"],
    ]) {
      const a = parsed(argv);
      expect(a.kind).toBe("error");
      if (a.kind === "error") expect(a.message).toMatch(/gaugeline audit/);
    }
  });

  it("refuses an empty or over-long name, contact or business, and a folder with no name", () => {
    for (const [flag, value] of [
      ["--business", "  "],
      ["--business", "x".repeat(121)],
      ["--brand", " "],
      ["--brand", "x".repeat(81)],
      ["--brand-contact", "x".repeat(201)],
      ["--out", " "],
    ] as const) {
      const a = parsed(["audit", "marlowe-bar.test", "--pack", flag, value]);
      expect(a.kind, `${flag} ${value.length}`).toBe("error");
      if (a.kind === "error") expect(a.message, flag).toContain(flag);
    }
  });

  it("takes only an https logo, with no user name or password", () => {
    for (const bad of [
      "http://studio.example/l.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      ["https://u:p", "studio.example/l.png"].join("@"),
      "studio.example/l.png",
    ]) {
      const a = parsed(["audit", "marlowe-bar.test", "--pack", "--brand-logo", bad]);
      expect(a.kind, bad).toBe("error");
      if (a.kind === "error") expect(a.message, bad).toMatch(/--brand-logo/);
    }
  });

  it("has no price flags: prices come only from gaugeline.services.json", () => {
    for (const flag of ["--rate", "--hours-per-point", "--price"]) {
      const a = parsed(["audit", "marlowe-bar.test", "--pack", flag, "1"]);
      expect(a.kind, flag).toBe("error");
    }
  });

  it("the flags belong to audit: the page check does not take them", () => {
    for (const flag of ["--pack", "--brand", "--brand-logo", "--brand-contact"]) {
      const a = parsed(["marlowe-bar.test", flag, "x"]);
      expect(a.kind, flag).toBe("error");
    }
  });

  it("--help is its own text and names every flag the command takes", () => {
    expect(parsed(["audit", "--help"])).toMatchObject({ kind: "help", command: "audit" });
    const help = HELP.audit ?? "";
    expect(help).toMatch(/Usage: gaugeline audit <address> --pack/);
    for (const f of flagsFor(FLAGS, "audit")) expect(help, f.name).toContain(`--${f.name}`);
    expect(
      flagsFor(FLAGS, "audit")
        .map((f) => f.name)
        .filter((n) =>
          ["pack", "brand", "brand-logo", "brand-contact", "business", "out", "force"].includes(n),
        )
        .sort(),
    ).toEqual(["brand", "brand-contact", "brand-logo", "business", "force", "out", "pack"]);
  });
});

describe("audit: e2e (CLI against the Corner Bar fixture)", () => {
  it("writes the HTML and the Markdown into the default folder, prints every path, exit 0", async () => {
    const cwd = folder();
    withServices(cwd);
    const r = await audit("corner-bar", ["--pack", "--business", "The Corner Bar"], cwd);
    expect(r.code).toBe(0);
    expect(lines(r.out)).toEqual([
      "Audit pack for 127.0.0.1: 6 things worth fixing.",
      "Wrote gaugeline-audit/audit-pack.html",
      "Wrote gaugeline-audit/audit-pack.md",
    ]);
    expect(readdirSync(join(cwd, "gaugeline-audit")).sort()).toEqual([
      "audit-pack.html",
      "audit-pack.md",
    ]);
    const md = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
    expect(lines(md)[0]).toBe("# Site audit: The Corner Bar");
    expect(md).toContain("## What we would fix, and what it costs");
    expect(md).toContain("### Search and sharing tidy-up");
    expect(md).toContain("**Price:** $450\u2013$700. **Time:** 4\u20136 hours.");
    expect(md).toContain("**Price:** $600\u2013$900. **Time:** 5\u20138 hours.");
    expect(md).toContain("**Total for the packages above:** $1,050\u2013$1,600, 9\u201314 hours.");
    expect(md).toContain("## Other findings");
    expect(md).toContain("Prepared by **Harbour Studio**");
    // Only the site's own pages were asked, and only with GET or HEAD.
    expect([...r.methods.keys()].sort().every((m) => m === "GET" || m === "HEAD")).toBe(true);
    // The report file is not written, and nothing is left beside the pack.
    expect(readdirSync(cwd).sort()).toEqual(["gaugeline-audit", "gaugeline.services.json"]);
  });

  it("builds the pack from the same findings and wording as the work order", async () => {
    const cwd = folder();
    withServices(cwd);
    await audit("corner-bar", ["--pack"], cwd);
    const md = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
    // The plain-English sentences are the checks' own, the ones `gaugeline brief` prints.
    expect(md).toContain(
      "Search engines treat the page as a copy, so it may never appear in results.",
    );
    expect(md).toContain("Each page's canonical tag names its own address.");
  });

  it("masks the visitor-facing email address the site shows, in both files", async () => {
    const cwd = folder();
    withServices(cwd);
    await audit("corner-bar", ["--pack"], cwd);
    for (const name of ["audit-pack.md", "audit-pack.html"]) {
      const text = readFileSync(join(cwd, "gaugeline-audit", name), "utf8");
      expect(text, name).not.toContain(["tables", "cornerbar.example"].join("@"));
      // Markdown escapes the stars; the HTML does not need to.
      expect(text, name).toContain(
        name.endsWith(".md") ? "t\\*\\*\\*@cornerbar.example" : "t***@cornerbar.example",
      );
    }
  });

  it("writes into --out, makes the folder, and never replaces a pack without --force", async () => {
    const cwd = folder();
    const first = await audit("corner-bar", ["--pack", "--out", join("quotes", "bar")], cwd);
    expect(first.code).toBe(0);
    expect(lines(first.out).slice(1)).toEqual([
      `Wrote ${join("quotes", "bar").replaceAll("\\", "/")}/audit-pack.html`,
      `Wrote ${join("quotes", "bar").replaceAll("\\", "/")}/audit-pack.md`,
    ]);
    writeFileSync(join(cwd, "quotes", "bar", "audit-pack.md"), "mine\n");
    const again = await audit("corner-bar", ["--pack", "--out", join("quotes", "bar")], cwd);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/audit-pack\.html, audit-pack\.md already exist/);
    expect(again.err).toMatch(/--force to replace the two files/);
    expect(readFileSync(join(cwd, "quotes", "bar", "audit-pack.md"), "utf8")).toBe("mine\n");
    const forced = await audit(
      "corner-bar",
      ["--pack", "--out", join("quotes", "bar"), "--force"],
      cwd,
    );
    expect(forced.code).toBe(0);
    expect(readFileSync(join(cwd, "quotes", "bar", "audit-pack.md"), "utf8")).toMatch(
      /^# Site audit: /,
    );
  });

  it("refuses an existing pack before the site is asked anything", async () => {
    const cwd = folder();
    mkdirSync(join(cwd, "gaugeline-audit"));
    writeFileSync(join(cwd, "gaugeline-audit", "audit-pack.html"), "mine\n");
    const r = await audit("corner-bar", ["--pack"], cwd);
    expect(r.code).toBe(2);
    expect(r.methods.size).toBe(0);
    expect(readdirSync(join(cwd, "gaugeline-audit"))).toEqual(["audit-pack.html"]);
  });

  it("refuses a folder outside the working folder, and one reached through a link, writing nothing", async () => {
    const cwd = folder();
    const elsewhere = folder();
    const out = await audit(
      "corner-bar",
      ["--pack", "--out", join("..", basename(elsewhere))],
      cwd,
    );
    expect(out.code).toBe(2);
    expect(out.err).toMatch(/outside the folder you ran the command in/);
    expect(readdirSync(elsewhere)).toEqual([]);
    let linked = false;
    try {
      symlinkSync(elsewhere, join(cwd, "out"), "junction");
      linked = true;
    } catch {
      // A platform that does not allow links without a privilege: the first refusal is the test.
    }
    if (linked) {
      const via = await audit("corner-bar", ["--pack", "--out", "out"], cwd);
      expect(via.code).toBe(2);
      expect(readdirSync(elsewhere)).toEqual([]);
    }
  });

  it("is all or nothing: when the second file cannot be written, the first is taken back", async () => {
    const cwd = folder();
    const failing: ScaffoldFs = {
      ...nodeFs,
      writeFile: async (path, text, flag) => {
        if (path.endsWith("audit-pack.md"))
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return nodeFs.writeFile(path, text, flag);
      },
    };
    const r = await audit("corner-bar", ["--pack"], cwd, failing);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Nothing was written/);
    expect(existsSync(join(cwd, "gaugeline-audit"))).toBe(false);
  });

  it("without a services file groups the findings by area, shows no price, and says why on stderr", async () => {
    const cwd = folder();
    const r = await audit("corner-bar", ["--pack"], cwd);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/No gaugeline\.services\.json here/);
    expect(r.err).toMatch(/never makes up a price/);
    const md = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
    expect(md).toContain("## What we found, by area");
    expect(md).not.toMatch(/\$|Price:|Total for/);
    const quiet = await audit("corner-bar", ["--pack", "--quiet", "--out", "q"], cwd);
    expect(quiet.err).not.toMatch(/services\.json/);
  });

  it("a package that names a check that does not exist is exit 2, before any request", async () => {
    const cwd = folder();
    withServices(cwd, {
      services: [
        {
          name: "Tidy-up",
          covers: { checks: ["canonical-elsewhere", "viewprt"] },
          price: { from: 1, to: 2 },
        },
      ],
    });
    const r = await audit("corner-bar", ["--pack"], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      'gaugeline.services.json: services.0.covers.checks.1: "viewprt" is not a check Gaugeline runs. Did you mean "viewport"?',
    );
    expect(r.methods.size).toBe(0);
    expect(existsSync(join(cwd, "gaugeline-audit"))).toBe(false);
  });

  it("a services file with the wrong shape is exit 2 and names the place", async () => {
    const cwd = folder();
    withServices(cwd, {
      services: [{ name: "Tidy-up", covers: { areas: ["Visitors"] } }],
    });
    const r = await audit("corner-bar", ["--pack"], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(
      /gaugeline\.services\.json: services\.0\.price: give a price range or an hours range/,
    );
    expect(r.methods.size).toBe(0);
    writeFileSync(join(cwd, "gaugeline.services.json"), "{ not json");
    const bad = await audit("corner-bar", ["--pack"], cwd);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/gaugeline\.services\.json is not valid JSON/);
  });

  it("--brand replaces the name in the file, and the logo and contact line come from the flags", async () => {
    const cwd = folder();
    withServices(cwd);
    await audit(
      "corner-bar",
      [
        "--pack",
        "--brand",
        "Okafor Web",
        "--brand-logo",
        "https://okafor.example/mark.svg",
        "--brand-contact",
        "Call Mia on 555 0142",
      ],
      cwd,
    );
    const html = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.html"), "utf8");
    expect(html).toContain('<img src="https://okafor.example/mark.svg" alt="Okafor Web">');
    expect(html).toContain("Prepared by <strong>Okafor Web</strong>. Call Mia on 555 0142");
    expect(html).not.toContain("Harbour Studio");
  });

  it("runs only the default checks: the pack says the private paths were not asked, and the mail records were not read", async () => {
    const cwd = folder();
    const r = await audit("corner-bar", ["--pack"], cwd);
    expect(r.code).toBe(0);
    const md = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
    expect(md).toContain("It did not ask for private or admin paths.");
    expect(md).toContain("The email records (SPF and DMARC) were not read.");
    // Not one request to a non-public path.
    expect(r.err).not.toMatch(/Probing checks are on/);
  });

  it("says so in the pack when the owner agreed to the probing checks, with the flag or with the file", async () => {
    const flagged = folder();
    const a = await audit("corner-bar", ["--pack", "--owner-consent"], flagged);
    expect(a.code).toBe(0);
    expect(a.err).toMatch(/Probing checks are on \(--owner-consent\)/);
    expect(readFileSync(join(flagged, "gaugeline-audit", "audit-pack.md"), "utf8")).toContain(
      "Because the site's owner agreed to it, it also asked the routes",
    );
    const filed = folder();
    writeFileSync(
      join(filed, "gaugeline.consent.json"),
      JSON.stringify({
        ownerConsent: { by: "Rosa Marlowe, owner of Marlowe Bar", on: "2026-11-09" },
      }),
    );
    const b = await audit("corner-bar", ["--pack"], filed);
    expect(b.err).toMatch(/Probing checks are on \(gaugeline\.consent\.json\)/);
    expect(readFileSync(join(filed, "gaugeline-audit", "audit-pack.md"), "utf8")).toContain(
      "Because the site's owner agreed to it",
    );
  });

  it("a site with nothing to fix produces a short healthy pack, not an empty one, exit 0", async () => {
    const cwd = folder();
    withServices(cwd);
    const r = await audit("clean", ["--pack", "--business", "Fixture Bakery"], cwd);
    expect(r.code).toBe(0);
    expect(lines(r.out)[0]).toBe("Audit pack for 127.0.0.1: nothing to fix.");
    const md = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.md"), "utf8");
    expect(md).toContain("found nothing to fix.");
    expect(md).toContain("# Site audit: Fixture Bakery");
    expect(md).not.toMatch(/## What we would fix|Price:/);
    expect(md.split(/\r?\n/).length).toBeLessThan(30);
  });

  it("the HTML is one file with no script and no link, and a policy that blocks everything but its own styles", async () => {
    const cwd = folder();
    withServices(cwd);
    await audit("corner-bar", ["--pack"], cwd);
    const html = readFileSync(join(cwd, "gaugeline-audit", "audit-pack.html"), "utf8");
    expect(html).not.toMatch(/<script|<link/i);
    expect(html).toContain("Content-Security-Policy");
  });
});
