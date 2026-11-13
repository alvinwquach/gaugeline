import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runId, type RenewalRow, type RunRecord } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { hostDir } from "../runs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-receipt-"));
  dirs.push(d);
  return d;
};

const SITE = "marlowe-bar.example";
const PAGE = { mainHash: "0123456789abcdef", links: [], types: [], scripts: [] };

/** A run record as `--since last` writes it, for the host's folder. */
function store(cwd: string, takenAt: string, findings: [string, string, string][] = []): void {
  const dir = hostDir(cwd, SITE);
  mkdirSync(dir, { recursive: true });
  const record: RunRecord = {
    schema: 1,
    id: runId(new Date(takenAt)),
    takenAt,
    pages: { "/": PAGE, "/visit": PAGE },
    findings: findings.map(([checkId, path, title]) => ({ checkId, path, title })),
  };
  writeFileSync(join(dir, `${record.id}.json`), `${JSON.stringify(record)}\n`);
}

/** October 2026, one run a day: two listing fixes and a domain renewal. */
function october(cwd: string): void {
  for (let day = 1; day <= 31; day++) {
    const d = `2026-10-${String(day).padStart(2, "0")}`;
    const f: [string, string, string][] = [];
    if (day >= 6 && day < 8)
      f.push(["listing-hours-mismatch", "/", "A listing shows different opening hours"]);
    if (day === 14)
      f.push(["listing-phone-mismatch", "/visit", "A listing shows a different phone number"]);
    if (day >= 20 && day < 24)
      f.push(["domain-expires-soon", "/", "The domain's registration runs out soon"]);
    store(cwd, `${d}T06:00:00.000Z`, f);
  }
}

async function run(
  argv: string[],
  cwd: string,
  deps: { renewalRows?: (host: string, now: Date) => Promise<RenewalRow[]> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => new Date("2026-11-13T09:00:00.000Z"),
    },
    { cwd, ...deps },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline receipt: arguments and help", () => {
  it("takes one site and a month, and the options a receipt has", () => {
    expect(parseCliArgs(["receipt", SITE, "--month", "2026-10"], {})).toMatchObject({
      kind: "receipt",
      address: `https://${SITE}/`,
      month: "2026-10",
      json: false,
      printable: false,
      renewals: false,
      clientReported: [],
    });
    expect(
      parseCliArgs(
        [
          "receipt",
          SITE,
          "--month",
          "2026-10",
          "--json",
          "--renewals",
          "--client-reported",
          "payment-link-dead@/visit",
          "--client-reported",
          "noindex",
        ],
        {},
      ),
    ).toMatchObject({
      json: true,
      printable: false,
      renewals: true,
      clientReported: [{ checkId: "payment-link-dead", path: "/visit" }, { checkId: "noindex" }],
    });
  });

  it("--printable is its own flag", () => {
    expect(parseCliArgs(["receipt", SITE, "--printable"], {})).toMatchObject({
      printable: true,
      json: false,
    });
  });

  it("leaves the month to the command when it is not given: the last whole month", () => {
    const a = parseCliArgs(["receipt", SITE], {});
    expect(a).toMatchObject({ kind: "receipt" });
    expect((a as { month?: string }).month).toBeUndefined();
  });

  it.each([
    [["receipt"], /needs the site/],
    [["receipt", "a.example", "b.example"], /takes one site/],
    [["receipt", SITE, "--month", "2026-13"], /yyyy-mm/],
    [["receipt", SITE, "--month", "last"], /yyyy-mm/],
    [["receipt", SITE, "--client-reported", "Not A Check"], /--client-reported/],
    [["receipt", SITE, "--client-reported", "noindex@visit"], /--client-reported/],
    [["receipt", SITE, "--json", "--printable"], /--json and --printable/],
  ])("refuses %j", (argv, message) => {
    const a = parseCliArgs(argv, {});
    expect(a.kind).toBe("error");
    expect((a as { message: string }).message).toMatch(message);
  });

  it("--month, --printable and --client-reported belong to receipt only", () => {
    for (const name of ["month", "printable", "client-reported"])
      expect(FLAGS.find((f) => f.name === name)?.commands, name).toEqual(["receipt"]);
    expect(parseCliArgs([SITE, "--month", "2026-10"], {}).kind).toBe("error");
    expect(FLAGS.find((f) => f.name === "json")?.commands).toContain("receipt");
    expect(FLAGS.find((f) => f.name === "renewals")?.commands).toContain("receipt");
  });

  it("every flag the help lists for receipt is in docs/options.md, and the help names the command", () => {
    const options = readFileSync(
      fileURLToPath(new URL("../../../../docs/options.md", import.meta.url)),
      "utf8",
    );
    const own = flagsFor(FLAGS, "receipt").map((f) => `--${f.name}`);
    expect(own).toEqual(
      expect.arrayContaining([
        "--month",
        "--json",
        "--printable",
        "--renewals",
        "--client-reported",
      ]),
    );
    for (const n of own) {
      expect(HELP.receipt, n).toContain(n);
      expect(options, n).toContain(n);
    }
    expect(HELP.receipt).toContain("gaugeline receipt <site>");
  });
});

describe("gaugeline receipt: end to end", () => {
  it("prints the block for the month from the stored runs", async () => {
    const cwd = tmp();
    october(cwd);
    const r = await run(["receipt", SITE, "--month", "2026-10"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`# ${SITE}: October 2026`);
    expect(r.out).toContain("3 fixed before your customers did");
    expect(r.out).toContain(
      "**A listing shows different opening hours** (on /, seen Tue 6 Oct, fixed by Thu 8 Oct)",
    );
    expect(r.out).toContain("The domain's registration runs out soon");
    expect(r.out).toContain("31 daily checks");
    expect(r.out).not.toContain("Coming up");
  });

  it("--json is the same receipt as data, and nothing else is on stdout", async () => {
    const cwd = tmp();
    october(cwd);
    const r = await run(["receipt", SITE, "--month", "2026-10", "--json"], cwd);
    const json = JSON.parse(r.out) as {
      schema: number;
      site: string;
      counts: Record<string, number>;
    };
    expect(json).toMatchObject({
      schema: 1,
      site: SITE,
      counts: { beforeCustomers: 3, stillOpen: 0 },
    });
    expect(r.err).toBe("");
  });

  it("--printable is one self-contained page", async () => {
    const cwd = tmp();
    october(cwd);
    const r = await run(["receipt", SITE, "--month", "2026-10", "--printable"], cwd);
    expect(r.out).toMatch(/^<!doctype html>/i);
    expect(r.out).toContain("3 fixed before your customers did");
    expect(r.out).not.toMatch(/<script|https?:\/\//i);
  });

  it("--client-reported moves a fix to 'fixed after you told us'", async () => {
    const cwd = tmp();
    october(cwd);
    const r = await run(
      ["receipt", SITE, "--month", "2026-10", "--client-reported", "listing-phone-mismatch@/visit"],
      cwd,
    );
    expect(r.out).toContain("2 fixed before your customers did");
    expect(r.out).toContain("1 fixed after you told us");
    expect(r.out).toMatch(
      /## Fixed after you told us[\s\S]*A listing shows a different phone number/,
    );
  });

  it("reads the renewals only when asked, and lists what is due in 60 days as coming up", async () => {
    const cwd = tmp();
    october(cwd);
    let calls = 0;
    const renewalRows = async (host: string): Promise<RenewalRow[]> => {
      calls++;
      expect(host).toBe(SITE);
      return [{ kind: "domain", subject: SITE, date: "2026-12-20T00:00:00.000Z", level: "fine" }];
    };
    const without = await run(["receipt", SITE, "--month", "2026-10"], cwd, { renewalRows });
    expect(calls).toBe(0);
    expect(without.out).not.toContain("Coming up");
    const withIt = await run(["receipt", SITE, "--month", "2026-10", "--renewals"], cwd, {
      renewalRows,
    });
    expect(calls).toBe(1);
    expect(withIt.out).toContain(`Domain ${SITE}: expires 20 Dec 2026, 36 days`);
  });

  it("a renewals read that fails leaves the receipt whole and says so on stderr", async () => {
    const cwd = tmp();
    october(cwd);
    const r = await run(["receipt", SITE, "--month", "2026-10", "--renewals"], cwd, {
      renewalRows: async () => {
        throw new Error("the registry did not answer");
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 fixed before your customers did");
    expect(r.err).toContain("Coming up was left out");
  });

  it("a quiet month says so with the true count", async () => {
    const cwd = tmp();
    for (let day = 1; day <= 31; day++)
      store(cwd, `2026-10-${String(day).padStart(2, "0")}T06:00:00.000Z`);
    const r = await run(["receipt", SITE, "--month", "2026-10"], cwd);
    expect(r.out).toContain("Nothing broke this month. 31 daily checks ran.");
  });

  it("defaults to the last whole month", async () => {
    const cwd = tmp();
    october(cwd);
    expect((await run(["receipt", SITE], cwd)).out).toContain("October 2026");
  });

  it("only reads the runs of the site it was given", async () => {
    const cwd = tmp();
    october(cwd);
    const other = join(cwd, ".gaugeline", "runs", "other-bar.example");
    mkdirSync(other, { recursive: true });
    const r = await run(["receipt", "other-bar.example", "--month", "2026-10"], cwd);
    expect(r.out).toContain("No checks ran this month");
    expect(r.out).not.toContain("listing");
  });

  it("says when no runs are stored at all, and never creates a folder or a file", async () => {
    const cwd = tmp();
    const r = await run(["receipt", SITE, "--month", "2026-10"], cwd);
    expect(r.code).toBe(0);
    expect(r.err).toContain("No runs are stored for this site yet");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("leaves the run files as they were", async () => {
    const cwd = tmp();
    october(cwd);
    const dir = hostDir(cwd, SITE);
    const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
    await run(["receipt", SITE, "--month", "2026-10", "--json"], cwd);
    expect(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")])).toEqual(before);
    expect(existsSync(join(cwd, "gaugeline-receipt.md"))).toBe(false);
  });

  it("refuses a month that has not started, with exit 2", async () => {
    const cwd = tmp();
    const r = await run(["receipt", SITE, "--month", "2026-12"], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toContain("has not started");
  });
});
