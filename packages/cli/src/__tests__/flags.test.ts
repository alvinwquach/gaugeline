import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBlock, replaceBlock } from "../../../../scripts/lib/marker-block.js";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { USAGE, describeParseError } from "../args.js";
import {
  FLAGS,
  flagsFor,
  HELP_WIDTH,
  nearestFlag,
  renderHelp,
  renderOptionsTable,
  resolveFlags,
  toParseArgsOptions,
  type FlagDef,
} from "../flags.js";
import { runBin } from "./helpers/bin.js";

/** A value each string flag accepts, for the every-flag test. */
const SAMPLE_VALUES: Record<string, string> = {
  since: "last",
  "notify-on": "any",
  "time-zone": "UTC",
  // A file with no tabs is one tab named after the file.
  sheet: "legacy-notes.csv",
  "legacy-from": "SEO Notes",
  "legacy-review": "review.csv",
  progress: "plan-state.json",
  "save-requests": "requests.json",
  tags: "utm_,ref",
  // Today is day 1 of the watch, whenever the test runs.
  watch: new Date().toISOString().slice(0, 10),
  live: `${fileURLToPath(new URL("../../../fixtures/plans/live/list.txt", import.meta.url))}`,
  ignore: "/tag/*",
  routes: "app/api/**/route.ts",
  schema: "schema.json",
  nav: "Footer",
  rank: `${fileURLToPath(new URL("../../../fixtures/plans/live/gsc-pages.csv", import.meta.url))}`,
  // brief: a name, whole dollars an hour and hours a point.
  business: "The Corner Bar",
  rate: "110",
  "hours-per-point": "1.5",
};

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const optionsMd = readFileSync(`${repoRoot}docs/options.md`, "utf8");
const head = { usage: "gaugeline <address> [options]", summary: "Check a site." };

/** A test table with the shapes the seed does not have yet: a string flag, a plan-only flag, a hidden flag. */
const EXTRA: FlagDef[] = [
  ...FLAGS,
  {
    name: "notify-on",
    type: "string",
    description: "Send a message when this severity is found",
    since: "0.1.0",
    commands: ["check"],
  },
  {
    name: "plan-only",
    type: "boolean",
    description: "Check the plan without a site",
    since: "0.1.0",
    commands: ["plan"],
  },
  {
    name: "debug-dump",
    type: "boolean",
    description: "Internal",
    since: "0.1.0",
    commands: ["*"],
    hidden: true,
  },
];

describe("flag table: unit", () => {
  it("toParseArgsOptions output for the seed table", () => {
    expect(toParseArgsOptions(FLAGS, "check")).toEqual({
      ci: { type: "boolean" },
      json: { type: "boolean" },
      "no-open": { type: "boolean" },
      "allow-private": { type: "boolean" },
      "allow-secret-key": { type: "boolean" },
      dns: { type: "boolean" },
      "owner-consent": { type: "boolean" },
      routes: { type: "string", multiple: true },
      since: { type: "string" },
      interactive: { type: "boolean", short: "i" },
      slack: { type: "string" },
      discord: { type: "string" },
      webhook: { type: "string" },
      email: { type: "string" },
      base: { type: "string" },
      "notify-on": { type: "string" },
      "report-url": { type: "string" },
      "save-requests": { type: "string" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    });
  });

  it("resolveFlags: CI=true turns ci on; CI='' and CI=0 do not; an explicit flag wins", () => {
    expect(resolveFlags({}, { CI: "true" }, FLAGS).ci).toBe(true);
    expect(resolveFlags({}, { CI: "" }, FLAGS).ci).toBeUndefined();
    expect(resolveFlags({}, { CI: "0" }, FLAGS).ci).toBeUndefined();
    expect(resolveFlags({}, { CI: "false" }, FLAGS).ci).toBeUndefined();
    expect(resolveFlags({ ci: false }, { CI: "true" }, FLAGS).ci).toBe(false);
    const withEnvString: FlagDef[] = [
      {
        name: "report-url",
        type: "string",
        description: "d",
        env: "REPORT_URL",
        since: "0.1.0",
        commands: ["*"],
      },
    ];
    expect(
      resolveFlags({}, { REPORT_URL: "https://r.example/" }, withEnvString)["report-url"],
    ).toBe("https://r.example/");
    expect(
      resolveFlags({ "report-url": "x" }, { REPORT_URL: "y" }, withEnvString)["report-url"],
    ).toBe("x");
  });

  it("renderHelp for the default command; no line is longer than 80 columns", () => {
    const help = renderHelp(FLAGS, "check", head);
    expect(help).toBe(
      [
        "Usage: gaugeline <address> [options]",
        "",
        "Check a site.",
        "",
        "Options:",
        '      --ci                       Exit 1 when a "Fix this first" finding is found',
        "                                 [CI]",
        "      --json                     Print the result as JSON on stdout, and nothing",
        "                                 else",
        "      --no-open                  Do not open anything in a browser",
        "      --allow-private            Allow addresses on this computer or a private",
        "                                 network, such as 127.0.0.1 or 192.168.x.x",
        "      --allow-secret-key         Use a Stripe secret key, with a notice, instead",
        "                                 of refusing it; a restricted key is safer",
        "      --dns                      Also read the domain's mail records (SPF and",
        "                                 DMARC) from DNS",
        "      --owner-consent            Run the probing checks, which ask routes for",
        "                                 what they protect with no login; only on sites",
        "                                 you may test",
        "      --routes <value>           With --owner-consent: download routes in files",
        "                                 matching this glob (repeatable); no glob: a",
        "                                 folder's signed-in routes",
        "      --since <value>            Page check: compare with the last run (the only",
        "                                 value is last). delivery: the window to read,",
        "                                 such as 7d",
        "  -i, --interactive              Open a terminal view of the results to move",
        "                                 through, filter and dismiss findings",
        "      --slack <value>            Send a summary to this Slack incoming webhook",
        "                                 (or set GAUGELINE_SLACK_WEBHOOK)",
        "      --discord <value>          Send an embed to this Discord webhook (or set",
        "                                 GAUGELINE_DISCORD_WEBHOOK)",
        "      --webhook <value>          POST the result as JSON to this address (or set",
        "                                 GAUGELINE_WEBHOOK)",
        "      --email <value>            Email the full report to these addresses",
        "                                 through Resend (or set GAUGELINE_EMAIL)",
        "      --base <value>             The site a plan is checked against (a preview);",
        "                                 the site emails link to; or the site to ask for",
        "                                 --routes",
        "      --notify-on <value>        When to send: any (something was found, the",
        "                                 default), high or always",
        "      --report-url <value>       Link each message to a hosted copy of the",
        "                                 report at this address",
        "      --save-requests <value>    Save the requests made and the page's data to",
        "                                 this JSON file; it may contain page content, so",
        "                                 do not commit it",
        "      --quiet                    Print only results and errors",
        "      --verbose                  Show each request, and technical detail when",
        "                                 something goes wrong",
        "  -h, --help                     Show this help and exit",
        "  -v, --version                  Print the version and exit",
      ].join("\n"),
    );
    for (const line of [...help.split("\n"), ...USAGE.split("\n")])
      expect(line.length).toBeLessThanOrEqual(HELP_WIDTH);
  });

  it("renderOptionsTable; pipes inside a description are escaped", () => {
    const table = renderOptionsTable([
      { name: "x", type: "boolean", description: "a | b", since: "0.2.0", commands: ["*"] },
    ]);
    expect(table).toBe(
      [
        "",
        "| Flag  | Does   | Environment variable | Since |",
        "| ----- | ------ | -------------------- | ----- |",
        "| `--x` | a \\| b |                      | 0.2.0 |",
        "",
      ].join("\n"),
    );
  });

  it("table invariants: unique names and short letters, kebab-case, semver since, short descriptions", () => {
    const names = FLAGS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    const shorts = FLAGS.flatMap((f) => (f.short ? [f.short] : []));
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const f of FLAGS) {
      expect(f.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(f.since).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.description.length).toBeLessThan(120);
      expect(f.description.endsWith(".")).toBe(false);
      expect(f.env ?? "").not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/);
    }
    expect(Object.isFrozen(FLAGS)).toBe(true);
  });

  it("nearest-flag suggestion: --jsno suggests --json; --zzz suggests nothing", () => {
    expect(nearestFlag("--jsno", FLAGS, "check")).toBe("json");
    expect(nearestFlag("--zzz", FLAGS, "check")).toBeUndefined();
  });
});

describe("flag table: integration (docs/options.md)", () => {
  it("docs:flags:check exits 0 on the committed tree", () => {
    const tsx = `${repoRoot}node_modules/tsx/dist/cli.mjs`;
    const r = spawnSync(process.execPath, [tsx, "scripts/build-docs.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("appending a flag without regenerating fails and names the missing row", () => {
    const more: FlagDef[] = [
      ...FLAGS,
      {
        name: "slack",
        type: "string",
        description: "Post to Slack",
        since: "0.1.0",
        commands: ["check"],
      },
    ];
    const r = checkBlock(optionsMd, "flags", renderOptionsTable(more));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--slack");
  });

  it("editing a description between the markers by hand fails the check", () => {
    const start = optionsMd.indexOf("<!-- flags:start -->");
    const edited =
      optionsMd.slice(0, start) +
      optionsMd.slice(start).replace("Print only results and errors", "Print only results");
    expect(checkBlock(edited, "flags", renderOptionsTable(FLAGS)).ok).toBe(false);
  });

  it("prose above and below the markers is byte-identical after regeneration", () => {
    const r = replaceBlock(optionsMd, "flags", renderOptionsTable(FLAGS));
    expect(r.ok && r.text).toBe(optionsMd);
    const r2 = replaceBlock(optionsMd, "flags", "X");
    if (!r2.ok) throw new Error(r2.error);
    const before = optionsMd.slice(0, optionsMd.indexOf("<!-- flags:start -->"));
    const after = optionsMd.slice(optionsMd.indexOf("<!-- flags:end -->"));
    expect(r2.text.startsWith(before)).toBe(true);
    expect(r2.text.endsWith(after)).toBe(true);
  });
});

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({ "/": html("<title>t</title>") });
});
afterAll(() => site.close());

describe("flag table: e2e", () => {
  it("gaugeline --help exits 0, prints to stdout, and lists every non-hidden flag exactly once", async () => {
    const r = await runBin(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const options = r.stdout.slice(r.stdout.indexOf("Options:"), r.stdout.indexOf("Exit codes:"));
    for (const f of flagsFor(FLAGS, "check").filter((x) => !x.hidden)) {
      expect(options.split(`--${f.name} `).length - 1, f.name).toBe(1);
    }
    // A flag of another command only (launch --dns) is not in the root help.
    for (const f of FLAGS.filter((x) => !flagsFor(FLAGS, "check").includes(x)))
      expect(options, f.name).not.toContain(`--${f.name} `);
  });

  it("gaugeline example.com --nope exits 2 with the one-line message and the hint", async () => {
    const r = await runBin(["example.com", "--nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n").slice(0, 2)).toEqual([
      "Unknown option --nope.",
      "Try: Run gaugeline --help to see every option.",
    ]);
  });

  it("a near miss suggests the real flag", async () => {
    const r = await runBin(["example.com", "--jsno"]);
    expect(r.stderr.split("\n")[0]).toBe("Unknown option --jsno. Did you mean --json?");
  });

  it("every flag in the table is accepted by the built bin", async () => {
    // --since writes its state file into the working directory: use a throwaway one.
    const scratch = mkdtempSync(join(tmpdir(), "gaugeline-flags-"));
    for (const f of FLAGS) {
      // gaugeline open never ends by itself: with --help it prints its usage and exits 0, which
      // still shows the bin accepts the flag for that command.
      if (f.commands.length === 1 && f.commands[0] === "open") {
        // A flag that takes a value (open --ads) is given one.
        const given = f.type === "string" ? [`--${f.name}`, "value"] : [`--${f.name}`];
        const r = await runBin(["open", "--help", ...given], {}, { cwd: scratch });
        expect(r.stderr, f.name).not.toContain("Unknown option");
        expect(r.status, f.name).toBe(0);
        continue;
      }
      // Each flag is given to a command that accepts it: launch-only flags to gaugeline launch,
      // digest-only flags to gaugeline digest over the fixture's saved runs.
      const runs = `${repoRoot}packages/fixtures/runs/digest-week`;
      const plan = `${repoRoot}packages/fixtures/plans/legacy-notes.csv`;
      const planOnly = f.commands[0] === "plan" && !f.commands.includes("check");
      const runOnly = f.commands.length === 1 && f.commands[0] === "run";
      // One site, the fixture, with a permission entry: run --site and --parallel check it.
      writeFileSync(
        join(scratch, "gaugeline.sites.json"),
        JSON.stringify({
          sites: [
            {
              name: "x",
              address: `${site.origin}/`,
              permission: { by: "flags test", on: "2026-11-01" },
            },
          ],
        }),
      );
      const printedOnly = f.commands.length === 1 && f.commands[0] === "printed";
      // A register of one printed address on the fixture, and a folder with no images to decode.
      const register = join(scratch, "printed.csv");
      writeFileSync(register, `url,where\n${site.origin}/,flags test\n`);
      mkdirSync(join(scratch, "no-images"), { recursive: true });
      // --out is also query --page's folder: the flag is proved on snapshot, its first command, as --force is on plan.
      const snapshotOnly = f.commands[0] === "snapshot" && !f.commands.includes("check");
      const cutoverOnly = f.commands.length === 1 && f.commands[0] === "cutover";
      const verifyOnly = f.commands.length === 1 && f.commands[0] === "verify";
      // The scratch folder has no gaugeline.sources.json, so --list says there are none and exits 0.
      const assertOnly = f.commands.length === 1 && f.commands[0] === "assert";
      const crawl = join(scratch, "crawl-export.csv");
      writeFileSync(crawl, "Address\nhttps://fernkiln.invalid/?_rsc=1\n");
      // A saved snapshot of a name that never resolves (.invalid): cutover reads it again.
      const before = join(scratch, "before.json");
      writeFileSync(
        before,
        JSON.stringify({
          schema: 1,
          domain: "fernkiln.invalid",
          takenAt: "2026-11-01T00:00:00.000Z",
          records: { a: [], aaaa: [], mx: [], spf: [], dmarc: [], dkim: {}, failed: [] },
          hosts: { bare: { status: 200 }, www: { status: 200 } },
        }),
      );
      // delivery and platform read an account with a key from the environment, so a run with the flag
      // alone would stop for the missing key (exit 2). --help parses every flag first and then stops,
      // so it proves the built bin accepts the flag for that command, with no key and no request.
      const deliveryOnly = f.commands.length === 1 && f.commands[0] === "delivery";
      const platformOnly = f.commands.length === 1 && f.commands[0] === "platform";
      // query --dupes reads a dataset (SANITY_PROJECT_ID), so it is proved the same way, with --help.
      const queryOnly = f.commands.length === 1 && f.commands[0] === "query";
      // brief runs the page check and writes a work order: its own flags are proved on a run.
      const briefOnly = f.commands.length === 1 && f.commands[0] === "brief";
      const digestOnly =
        !deliveryOnly &&
        !platformOnly &&
        !queryOnly &&
        !briefOnly &&
        !planOnly &&
        !printedOnly &&
        !snapshotOnly &&
        !cutoverOnly &&
        !verifyOnly &&
        !runOnly &&
        !flagsFor(FLAGS, "check").includes(f) &&
        !flagsFor(FLAGS, "launch").includes(f);
      // A string flag needs a value: the one it accepts.
      const value =
        f.type === "string" ? [f.name === "runs" ? runs : (SAMPLE_VALUES[f.name] ?? "x")] : [];
      // --base on the page check is read only with --routes (no glob), over a folder with an app directory.
      mkdirSync(join(scratch, "src", "app"), { recursive: true });
      writeFileSync(join(scratch, "src", "app", "page.tsx"), "export default () => null;\n");
      const args =
        f.name === "base"
          ? [
              "check",
              "src",
              "--routes",
              `--${f.name}`,
              `${site.origin}/`,
              "--owner-consent",
              "--allow-private",
            ]
          : briefOnly
            ? ["brief", `${site.origin}/`, "--allow-private", `--${f.name}`, ...value]
            : planOnly
              ? [
                  "plan",
                  // --nav reads menu tabs: a workbook that has them.
                  f.name === "nav" ? `${repoRoot}packages/fixtures/plans/nav-workbook.txt` : plan,
                  ...(f.name === "legacy-review" ? ["--legacy-from", "SEO Notes"] : []),
                  // --progress and --all compare runs against a preview: they need --base.
                  // --rank joins traffic numbers to --live's list: it needs --live.
                  ...(f.name === "rank" ? ["--live", SAMPLE_VALUES.live ?? ""] : []),
                  ...(f.name === "progress" ||
                  f.name === "all" ||
                  f.name === "printed" ||
                  f.name === "watch"
                    ? ["--base", `${site.origin}/`, "--allow-private"]
                    : []),
                  `--${f.name}`,
                  ...(f.name === "base"
                    ? [`${site.origin}/`, "--allow-private"]
                    : f.name === "printed"
                      ? [register]
                      : value),
                ]
              : snapshotOnly
                ? ["snapshot", "fernkiln.invalid", `--${f.name}`, join(scratch, "snapshot.json")]
                : deliveryOnly || platformOnly || queryOnly
                  ? [
                      deliveryOnly ? "delivery" : platformOnly ? "platform" : "query",
                      `--${f.name}`,
                      ...value,
                      "--help",
                    ]
                  : cutoverOnly
                    ? ["cutover", `--${f.name}`, before]
                    : assertOnly
                      ? ["assert", `--${f.name}`]
                      : verifyOnly
                        ? ["verify", crawl, `--${f.name}`, "0"]
                        : runOnly
                          ? f.name === "tag"
                            ? ["run", "--tag", "nobody"]
                            : f.name === "site"
                              ? ["run", "--site", "x", "--allow-private"]
                              : ["run", "--tag", "nobody", `--${f.name}`, "2"]
                          : printedOnly
                            ? [
                                "printed",
                                register,
                                "--allow-private",
                                `--${f.name}`,
                                ...(f.name === "decode" ? [join(scratch, "no-images")] : value),
                              ]
                            : digestOnly
                              ? [
                                  "digest",
                                  ...(f.name === "runs" ? [] : ["--runs", runs]),
                                  `--${f.name}`,
                                  ...value,
                                ]
                              : [
                                  ...(flagsFor(FLAGS, "check").includes(f) ? [] : ["launch"]),
                                  `${site.origin}/`,
                                  // --routes is read by a probing check: it needs the owner's consent.
                                  ...(f.name === "routes" ? ["--owner-consent"] : []),
                                  `--${f.name}`,
                                  ...value,
                                ];
      const r = await runBin(args, {}, { cwd: scratch });
      expect(r.stderr, f.name).not.toContain("Unknown option");
      expect([0, 1], f.name).toContain(r.status);
    }
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);
});

describe("flag table: edge cases", () => {
  it("a negated boolean (no-open) parses as its own name and is never --no-no-open", () => {
    const parsed = parseArgs({
      args: ["--no-open"],
      options: toParseArgsOptions(FLAGS, "check"),
      strict: true,
      allowPositionals: true,
    });
    expect(parsed.values["no-open"]).toBe(true);
    expect(renderHelp(FLAGS, "check", head)).not.toContain("--no-no-open");
    expect(renderOptionsTable(FLAGS)).toContain("`--no-open`");
  });

  it("a string flag given without a value is a config error naming the flag", () => {
    let err: unknown;
    try {
      parseArgs({
        args: ["--notify-on"],
        options: toParseArgsOptions(EXTRA, "check"),
        strict: true,
        allowPositionals: true,
      });
    } catch (e) {
      err = e;
    }
    expect(describeParseError(err, EXTRA, "check").message).toBe("--notify-on needs a value.");
  });

  it("a flag valid for plan only is rejected on the default command and absent from its help", () => {
    expect(() =>
      parseArgs({
        args: ["--plan-only"],
        options: toParseArgsOptions(EXTRA, "check"),
        strict: true,
        allowPositionals: true,
      }),
    ).toThrow();
    expect(renderHelp(EXTRA, "check", head)).not.toContain("--plan-only");
    expect(renderHelp(EXTRA, "plan", head)).toContain("--plan-only");
  });

  it("a hidden flag parses and appears in neither help nor docs", () => {
    const parsed = parseArgs({
      args: ["--debug-dump"],
      options: toParseArgsOptions(EXTRA, "check"),
      strict: true,
      allowPositionals: true,
    });
    expect(parsed.values["debug-dump"]).toBe(true);
    expect(renderHelp(EXTRA, "check", head)).not.toContain("debug-dump");
    expect(renderOptionsTable(EXTRA)).not.toContain("debug-dump");
  });

  it("docs/options.md with one marker missing: a clear error and nothing written", () => {
    const broken = optionsMd.replace("<!-- flags:end -->", "");
    const r = replaceBlock(broken, "flags", renderOptionsTable(FLAGS));
    expect(r).toEqual({
      ok: false,
      error: "Marker <!-- flags:end --> not found. Add both markers around the generated table.",
    });
  });

  it("Windows line endings in docs/options.md do not cause a false difference", () => {
    const crlf = optionsMd.replace(/\n/g, "\r\n");
    expect(checkBlock(crlf, "flags", renderOptionsTable(FLAGS)).ok).toBe(true);
  });
});
