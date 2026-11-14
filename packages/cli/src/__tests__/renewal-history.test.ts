import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiryFinding, type Certificate } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { buildRunRecord, hostDir, readRuns, renewalChecksRead } from "../runs.js";
import { BAR_CONFIG, ENV, GITHUB_TOKEN, world } from "./helpers/renewals-world.js";

/**
 * Renewal and certificate findings are about the site, not about a page, so a run keeps them beside
 * the page's findings (`siteFindings`) and lists the renewal checks it could read (`renewalChecks`). The
 * care receipt's Renewals group and the before-and-after report read them from there.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const folder = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-renewal-history-")));
  dirs.push(dir);
  return dir;
};

const snapshot = { finalUrl: "https://marlowe-bar.example/menu" } as Parameters<
  typeof buildRunRecord
>[0];
const record = { mainHash: "a".repeat(16), links: [], types: [], scripts: [] };
const at = new Date("2026-11-03T10:00:00Z");
const f = (checkId: string, url: string, title = "A title") => ({ checkId, url, title });

describe("what a run keeps of a finding that is not on the checked page", () => {
  it("an expiring certificate of www is kept as a site finding, not dropped", () => {
    const cert: Certificate = {
      names: ["www.marlowe-bar.example"],
      validFrom: "2026-08-14T12:00:00.000Z",
      validTo: "2026-11-10T12:00:00.000Z",
      issuer: "Invented Authority",
    };
    const finding = expiryFinding(
      cert,
      at,
      "https://www.marlowe-bar.example/",
      "www.marlowe-bar.example",
    )!;
    const run = buildRunRecord(snapshot, record, [finding], at, {
      renewalChecks: ["certificate-expiring", "domain-expires-soon"],
    });
    expect(run.findings).toEqual([]);
    expect(run.siteFindings).toEqual([
      {
        checkId: "certificate-expiring",
        address: "https://www.marlowe-bar.example/",
        title: "The site's certificate expires soon",
      },
    ]);
    expect(run.renewalChecks).toEqual(["certificate-expiring", "domain-expires-soon"]);
    expect(run.offPage).toBeUndefined();
  });

  it("keeps domain:, token: and vercel: addresses as they are", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [
        f("domain-expires-soon", "domain:marlowe-bar.example"),
        f("token-expires-soon", "token:github"),
        f("runtime-deprecated", "vercel:marlowe-bar-site"),
      ],
      at,
      { renewalChecks: ["certificate-expiring", "domain-expires-soon"] },
    );
    expect(run.siteFindings?.map((s) => s.address)).toEqual([
      "domain:marlowe-bar.example",
      "token:github",
      "vercel:marlowe-bar-site",
    ]);
  });

  it("a renewal finding on the page itself stays where it was: a page finding, as in older runs", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [f("certificate-expiring", "https://marlowe-bar.example/menu")],
      at,
      { renewalChecks: ["certificate-expiring", "domain-expires-soon"] },
    );
    expect(run.findings.map((x) => x.checkId)).toEqual(["certificate-expiring"]);
    expect(run.siteFindings).toBeUndefined();
  });

  it("other findings on other pages are still only counted, and the counter says so", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [
        f("link-broken", "https://marlowe-bar.example/book"),
        f("domain-expired", "domain:marlowe-bar.example"),
      ],
      at,
      { renewalChecks: ["certificate-expiring", "domain-expires-soon"] },
    );
    expect(run.offPage).toBe(1);
    expect(run.siteFindings).toHaveLength(1);
  });

  it("two domains of one check are two site findings; the same address twice is one", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [
        f("domain-expires-soon", "domain:marlowe-bar.example"),
        f("domain-expires-soon", "domain:marlowe-grill.example"),
        f("domain-expires-soon", "domain:marlowe-bar.example"),
      ],
      at,
    );
    expect(run.siteFindings?.map((s) => s.address)).toEqual([
      "domain:marlowe-bar.example",
      "domain:marlowe-grill.example",
    ]);
  });

  it("a renewal finding whose address cannot be read is counted, not recorded under a guess", () => {
    const run = buildRunRecord(snapshot, record, [f("domain-expires-soon", "http://[bad")], at);
    expect(run.siteFindings).toBeUndefined();
    expect(run.offPage).toBe(1);
  });

  it("an http address keeps its origin and path only: no query, no userinfo, no fragment", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [
        f(
          "cert-name-mismatch",
          `https://${["user", "pw"].join(":")}@www.marlowe-bar.example/x?key=1#frag`,
        ),
      ],
      at,
    );
    expect(run.siteFindings?.[0]?.address).toBe("https://www.marlowe-bar.example/x");
  });

  it("the title is cut at 200 characters and the evidence is never stored", () => {
    const SECRET = ["tok", "en-evidence-only"].join("");
    const run = buildRunRecord(
      snapshot,
      record,
      [
        {
          ...f("token-expires-soon", "token:github", "t".repeat(300)),
          evidence: `the token ${SECRET} expires 3 Dec 2026`,
        } as ReturnType<typeof f>,
      ],
      at,
    );
    expect(run.siteFindings?.[0]?.title).toHaveLength(200);
    expect(JSON.stringify(run)).not.toContain(SECRET);
  });

  it("renewalChecks is left out when empty, so a run without --renewals looks as it always did", () => {
    const run = buildRunRecord(snapshot, record, [], at, { renewalChecks: [] });
    expect("renewalChecks" in run).toBe(false);
    expect("siteFindings" in run).toBe(false);
  });
});

describe("renewalChecksRead: absent only means fixed for a check that was really read", () => {
  const ran = { passed: ["domain-expired", "domain-status-hold"], failed: [], couldNotCheck: [] };
  it("is empty without --renewals", () => {
    expect(renewalChecksRead(false, [], ran)).toEqual([]);
    expect(renewalChecksRead(true, [], ran)).toEqual(["domain-expired", "domain-status-hold"]);
  });
  it("leaves out a renewal check that could not read what it needed, or failed", () => {
    expect(
      renewalChecksRead(true, [], {
        ...ran,
        couldNotCheck: [{ id: "domain-expired", reason: "the registry did not answer", url: "u" }],
      }),
    ).toEqual(["domain-status-hold"]);
    expect(
      renewalChecksRead(true, [], { ...ran, failed: [{ id: "domain-status-hold", error: "e" }] }),
    ).toEqual(["domain-expired"]);
  });
  it("is empty when no renewal check ran at all (a run that skipped them)", () => {
    expect(
      renewalChecksRead(true, [], { passed: ["title"], failed: [], couldNotCheck: [] }),
    ).toEqual([]);
  });
  it("counts a check that found something as having run, and ignores checks that are not renewals", () => {
    expect(
      renewalChecksRead(true, [f("domain-expires-soon", "domain:x.example")], {
        passed: ["title"],
        failed: [],
        couldNotCheck: [],
      }),
    ).toEqual(["domain-expires-soon"]);
  });
});

describe("end to end: two runs of an invented bar, then the receipt and the before-and-after", () => {
  const FIRST = new Date("2026-11-11T09:00:00Z");
  const SECOND = new Date("2026-11-12T09:00:00Z");
  async function run(
    argv: string[],
    cwd: string,
    now: Date,
    over: Parameters<typeof world>[0] = {},
  ) {
    const { transport } = world(over);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      argv,
      {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        env: ENV,
        now: () => now,
      },
      { cwd, now: () => now, fetcher: { transport } } as never,
    );
    return { code, out: out.join(""), err: err.join("") };
  }
  const RENEWED = {
    "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
      status: 200,
      body: {
        objectClassName: "domain",
        ldhName: "marlowe-bar.com",
        status: ["client transfer prohibited"],
        events: [{ eventAction: "expiration", eventDate: "2027-12-03T14:02:11Z" }],
      },
    },
  };
  const args = ["marlowe-bar.com", "--renewals", "--since", "last", "--no-open", "--quiet"];

  it("the history file holds the renewal findings, and the receipt lists the fixed one under Renewals", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "gaugeline.renewals.json"), BAR_CONFIG);
    await run(args, cwd, FIRST);
    await run(args, cwd, SECOND, RENEWED);

    const files = readdirSync(hostDir(cwd, "marlowe-bar.com"));
    expect(files).toEqual(["r-20261111T090000Z.json", "r-20261112T090000Z.json"]);
    const { runs } = readRuns(cwd, "marlowe-bar.com");
    const first = runs[0]!;
    expect(first.renewalChecks).toEqual(
      expect.arrayContaining(["domain-expires-soon", "domain-expired"]),
    );
    expect(first.siteFindings?.map((s) => `${s.checkId} ${s.address}`)).toEqual(
      expect.arrayContaining([
        "domain-expires-soon domain:marlowe-bar.com",
        "token-expires-soon token:github",
        "runtime-deprecated vercel:marlowe-bar-site",
        "cert-name-mismatch https://www.marlowe-bar.com/",
      ]),
    );
    expect(runs[1]!.siteFindings?.map((s) => s.checkId)).not.toContain("domain-expires-soon");
    // No key and no evidence in the file.
    for (const name of files)
      expect(readFileSync(join(hostDir(cwd, "marlowe-bar.com"), name), "utf8")).not.toContain(
        GITHUB_TOKEN,
      );

    const receipt = await run(
      ["receipt", "marlowe-bar.com", "--month", "2026-11"],
      cwd,
      new Date("2026-11-13T09:00:00Z"),
    );
    expect(receipt.code).toBe(0);
    expect(receipt.out).toContain("### Renewals");
    expect(receipt.out).toContain(
      "- **The domain's registration runs out soon** (domain:marlowe-bar.com, seen Wed 11 Nov, fixed by Thu 12 Nov).",
    );

    const diff = await run(
      ["changes", "marlowe-bar.com", "--before-after"],
      cwd,
      new Date("2026-11-13T09:00:00Z"),
    );
    expect(diff.out).toContain("Renewals fixed (1)");
    expect(diff.out).toContain("domain:marlowe-bar.com");
  });

  it("an expiring certificate on the page's own address is recorded and listed under Renewals too", async () => {
    const cwd = folder();
    const NEAR = {
      "GET https://marlowe-bar.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<!doctype html><html lang=en><title>Marlowe Bar</title><h1>Marlowe Bar</h1><p>Open.</p></html>",
        certificate: {
          names: ["marlowe-bar.com"],
          validFrom: "2026-08-14T12:00:00.000Z",
          validTo: "2026-11-14T12:00:00.000Z",
          issuer: "Invented Authority",
        },
      },
    };
    const FAR = {
      "GET https://marlowe-bar.com/": {
        ...NEAR["GET https://marlowe-bar.com/"],
        certificate: {
          names: ["marlowe-bar.com"],
          validFrom: "2026-11-12T12:00:00.000Z",
          validTo: "2027-02-12T12:00:00.000Z",
          issuer: "Invented Authority",
        },
      },
    };
    const plain = ["marlowe-bar.com", "--since", "last", "--no-open", "--quiet"];
    await run(plain, cwd, FIRST, NEAR);
    await run(plain, cwd, SECOND, FAR);
    const receipt = await run(
      ["receipt", "marlowe-bar.com", "--month", "2026-11"],
      cwd,
      new Date("2026-11-13T09:00:00Z"),
    );
    expect(receipt.out).toContain("### Renewals");
    expect(receipt.out).toContain("The site's certificate expires soon");
  });
});
