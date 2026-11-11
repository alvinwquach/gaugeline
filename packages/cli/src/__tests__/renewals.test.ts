import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSchema } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { runAll } from "../run-all.js";
import {
  BAR_CONFIG,
  ENV,
  GITHUB_TOKEN,
  NOW,
  VERCEL_TOKEN,
  world,
} from "./helpers/renewals-world.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(config?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-renewals-")));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "gaugeline.renewals.json"), config);
  return dir;
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined> = ENV,
  over: Parameters<typeof world>[0] = {},
) {
  const { transport, seen } = world(over);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env },
    { cwd, now: () => NOW, fetcher: { transport } } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

const lines = (text: string) => text.split("\n");

describe("gaugeline renewals: end to end (recorded responses)", () => {
  it("prints the Renewals list by date, then the findings, and exits 0 without --ci", async () => {
    const r = await run(
      ["renewals", "marlowe-bar.com", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(r.code).toBe(EXIT.ok);
    const text = lines(r.out);
    const at = text.indexOf("Renewals for marlowe-bar.com, by date");
    expect(at).toBe(0);
    expect(text.slice(1, 7)).toEqual([
      "Fix first  Certificate for www.marlowe-bar.com: its certificate does not name it (it names marlowe-bar.com)",
      "Fix first  Vercel project marlowe-bar-site, Node.js 18.x: retired 1 Sep 2025, 436 days ago; no retirement announced".replace(
        "; no retirement announced",
        "",
      ),
      "Fix first  Certificate for marlowe-bar.com: expires 14 Nov 2026, 3 days",
      "Fix soon   GitHub token (GAUGELINE_GITHUB_TOKEN): expires 26 Nov 2026, 14 days",
      "Fix soon   Domain marlowe-bar.com: expires 3 Dec 2026, 22 days; registrar Plume Registrar, Inc.",
      "-          Vercel token (GAUGELINE_VERCEL_TOKEN): no expiry reported",
    ]);
    expect(r.out).toContain("The bare domain or www is not covered by the certificate");
    expect(r.out).toContain("The domain's registration runs out soon");
    expect(r.out).toMatch(/no expiry reported for the Vercel token/);
  });

  it("exits 1 with --ci when something is fix first", async () => {
    const r = await run(
      ["renewals", "marlowe-bar.com", "--ci", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(r.code).toBe(EXIT.findings);
  });

  it("--json prints the schema 2 result and nothing else, with no key in it", async () => {
    const r = await run(
      ["renewals", "marlowe-bar.com", "--json", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(r.out.startsWith("{")).toBe(true);
    const parsed = resultSchema.parse(JSON.parse(r.out));
    expect(parsed.findings.map((f) => f.checkId).sort()).toEqual([
      "cert-name-mismatch",
      "certificate-expiring",
      "domain-expires-soon",
      "runtime-deprecated",
      "token-expires-soon",
    ]);
    expect(r.out).not.toContain(GITHUB_TOKEN);
    expect(r.out).not.toContain(VERCEL_TOKEN);
    expect(r.out).not.toContain("Renewals for");
  });

  it("writes the report with one Renewals section, by date", async () => {
    const dir = folder(BAR_CONFIG);
    await run(["renewals", "marlowe-bar.com", "--no-open", "--quiet"], dir);
    const html = readFileSync(join(dir, "gaugeline-report.html"), "utf8");
    expect(html.match(/<h2>Renewals /g)).toHaveLength(1);
    expect(html).toContain(
      "14 Nov 2026: The certificate for marlowe-bar.com expires on 2026-11-14",
    );
    expect(html).toContain("3 Dec 2026: marlowe-bar.com expires 3 Dec 2026, 22 days");
  });

  it("reads a lapsed domain even though the site does not answer", async () => {
    const r = await run(["renewals", "cedar-clinic.co.uk", "--no-open"], folder());
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toContain(
      "The site did not answer (cedar-clinic.co.uk could not be found), which is what a lapsed domain looks like. The registration and the other renewals were still read.",
    );
    expect(r.out).toContain(
      "Fix first  Domain cedar-clinic.co.uk: expired 2 Nov 2026, 9 days ago; registrar Harbour Names Ltd; on hold, so it does not resolve",
    );
    expect(r.out).toContain(
      'cedar-clinic.co.uk has the status "client hold", so it does not resolve',
    );
    expect(r.out).toContain(
      "cedar-clinic.co.uk expired 2 Nov 2026, 9 days ago (registrar Harbour Names Ltd)",
    );
  });

  it("asks only GET or HEAD, and no token or Vercel project that was not set up", async () => {
    const r = await run(["renewals", "marlowe-bar.com", "--no-open", "--quiet"], folder(), {
      NO_COLOR: "1",
    });
    expect(new Set(r.seen.map((s) => s.method))).toEqual(new Set(["GET", "HEAD"]));
    expect(
      r.seen.some((s) => s.url.includes("api.github.com") || s.url.includes("api.vercel.com")),
    ).toBe(false);
    expect(r.out).toMatch(
      /no token is set up \(set GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN/,
    );
  });

  it("a gaugeline.renewals.json that does not read is exit 2, naming the file", async () => {
    const r = await run(
      ["renewals", "marlowe-bar.com", "--no-open"],
      folder('{"vercel":{"projects":[]}}'),
    );
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("gaugeline.renewals.json");
  });
});

describe("the page check with --renewals, and the nightly run", () => {
  it("adds the renewals checks to the page check only when asked", async () => {
    const dir = folder(BAR_CONFIG);
    const without = await run(["marlowe-bar.com", "--json", "--no-open", "--quiet"], dir);
    expect(
      without.seen.some((s) => s.url.includes("rdap.") || s.url.includes("data.iana.org")),
    ).toBe(false);
    const ids = (text: string) =>
      resultSchema.parse(JSON.parse(text)).findings.map((f) => f.checkId);
    expect(ids(without.out)).not.toContain("domain-expires-soon");
    const withIt = await run(
      ["marlowe-bar.com", "--renewals", "--json", "--no-open", "--quiet"],
      dir,
    );
    expect(ids(withIt.out)).toEqual(
      expect.arrayContaining(["domain-expires-soon", "cert-name-mismatch", "runtime-deprecated"]),
    );
  });

  it("run --all --renewals hands the flag to every site's run", async () => {
    const dir = folder();
    mkdirSync(join(dir, "runs"));
    const seen: string[][] = [];
    const site = {
      name: "marlowe-bar",
      address: "https://marlowe-bar.com",
      host: "marlowe-bar.com",
      configDir: dir,
      permission: { by: "Maya Ortiz, owner of Marlowe Bar", on: "2026-11-01" },
    };
    const runOne = async (argv: string[]) => {
      seen.push(argv);
      return 0;
    };
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, renewals: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--renewals");
    expect(seen[1]).not.toContain("--renewals");
  });

  it("parses --renewals on the page check and on run, and the renewals command", () => {
    const a = parseCliArgs(["marlowe-bar.com", "--renewals"], {});
    expect(a.kind === "run" && a.renewals).toBe(true);
    const b = parseCliArgs(["renewals", "marlowe-bar.com"], {});
    expect(b.kind === "run" && b.renewals && b.command).toBe("renewals");
    const c = parseCliArgs(["run", "--all", "--renewals"], {});
    expect(c.kind === "run-all" && c.renewals).toBe(true);
    const d = parseCliArgs(["marlowe-bar.com"], {});
    expect(d.kind === "run" && d.renewals).toBe(false);
  });

  it("needs one address", () => {
    expect(parseCliArgs(["renewals"], {}).kind).toBe("error");
  });
});

describe("renewals: help and flags", () => {
  it("has its own help, which lists the flags it accepts", () => {
    const help = HELP.renewals ?? "";
    expect(help).toContain("gaugeline renewals <address>");
    expect(help).toContain("--ci");
    expect(help).toContain("--json");
    expect(help).toContain("--allow-private");
    expect(help).not.toContain("--dns");
  });

  it("the --renewals flag is on the page check and on run, and described the same in help and docs", () => {
    const flag = FLAGS.find((f) => f.name === "renewals");
    expect(flag?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--renewals");
  });
});
