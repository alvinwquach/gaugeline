import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PAGESPEED_HOSTS, resultSchema, type Transport } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  answer,
  pageSpeedTransport,
  type AnswerOptions,
  type Reply,
} from "../../../core/src/pagespeed/__tests__/world.js";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../../../testkit/src/index.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

/**
 * `gaugeline <site> --pagespeed` (PERF-01), in memory: the invented Corner Pantry shop answers from its fixture
 * folder, and Google's PageSpeed Insights answers from invented numbers (no network, no key).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-pagespeed-")));
  dirs.push(dir);
  return dir;
}

const HOST = "corner-pantry.example";
const HOME = `https://${HOST}/`;
const GOOD = [0.9, 0.05, 0.05] as const;

const ok = (o: AnswerOptions): Reply => ({ status: 200, body: answer(HOME, o) });

async function run(argv: string[], replies: Record<string, Reply>) {
  const seen: { method: string; url: string }[] = [];
  const others: Transport = (_url, req) =>
    Promise.resolve({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from("not found")]),
    });
  const site = staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others);
  const psi = pageSpeedTransport(replies);
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return url.hostname === "pagespeedonline.googleapis.com"
      ? psi.transport(url, req)
      : site(url, req);
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd: folder(), fetcher: { transport } } as never,
  );
  return {
    code,
    out: out.join(""),
    err: err.join(""),
    seen,
    asked: psi.seen.map((s) => ({
      method: s.method,
      page: new URL(s.url).searchParams.get("url"),
      url: s.url,
    })),
  };
}

const parsed = (text: string) => {
  const result = resultSchema.parse(JSON.parse(text));
  const ours = (id: string) => ({
    findings: result.findings.filter((f) => f.checkId === id),
    couldNotCheck: result.couldNotCheck.filter((c) => c.id === id),
  });
  return { field: ours("pagespeed-field-vitals"), lab: ours("pagespeed-lab-advice") };
};

describe("gaugeline check --pagespeed: end to end (the invented shop, in memory)", () => {
  it("reports real visitors' poor vital and the lab score as two separate checks", async () => {
    const r = await run([HOST, "--pagespeed", "--json", "--no-open", "--quiet"], {
      [HOME]: ok({
        field: { lcp: [0.4, 0.2, 0.4], inp: GOOD, cls: GOOD },
        lab: { score: 0.42, lcp: 4210, tbt: 610, cls: 0.123, si: 5100 },
      }),
    });
    expect(r.code).toBe(EXIT.ok);
    const got = parsed(r.out);
    expect(got.field.findings.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "Real visitors (Chrome, 75th percentile), https://corner-pantry.example/: Largest Contentful Paint is poor. 40% of loads were 2.5 s or faster; 75% are needed. 40% took longer than 4 s.",
      ],
    ]);
    expect(got.lab.findings.map((f) => f.severity)).toEqual(["low"]);
    expect(got.lab.findings[0]?.evidence).toContain("Lab run, not real visitors");
  });

  it("real visitors decide: a terrible lab score with good real-user figures is advice and no failure", async () => {
    const r = await run([HOST, "--pagespeed", "--ci", "--json", "--no-open", "--quiet"], {
      [HOME]: ok({ field: { lcp: GOOD, inp: GOOD, cls: GOOD }, lab: { score: 0.1, lcp: 15000 } }),
    });
    expect(r.code).toBe(EXIT.ok);
    const got = parsed(r.out);
    expect(got.field.findings).toEqual([]);
    expect(got.lab.findings.map((f) => f.severity)).toEqual(["low"]);
  });

  it("missing real-user data is could-not-check, never a pass", async () => {
    const r = await run([HOST, "--pagespeed", "--json", "--no-open", "--quiet"], {
      [HOME]: ok({ lab: { score: 1 } }),
    });
    const got = parsed(r.out);
    expect(got.field.findings).toEqual([]);
    expect(got.field.couldNotCheck[0]?.reason).toContain("no real-user data");
  });

  it("a used-up keyless quota is could-not-check with the reason, and the run still finishes", async () => {
    const r = await run([HOST, "--pagespeed", "--json", "--no-open", "--quiet"], {
      [HOME]: { status: 429, body: { error: { code: 429 } } },
    });
    expect(r.code).toBe(EXIT.ok);
    const got = parsed(r.out);
    expect(got.field.findings).toEqual([]);
    expect(got.field.couldNotCheck[0]?.reason).toContain("quota is used up");
  });

  it("is not in the run without --pagespeed: no finding, no note and nothing sent to Google", async () => {
    const r = await run([HOST, "--json", "--no-open", "--quiet"], {});
    expect(r.asked).toEqual([]);
    expect(r.seen.some((s) => s.url.includes("googleapis.com"))).toBe(false);
    expect(parsed(r.out)).toEqual({
      field: { findings: [], couldNotCheck: [] },
      lab: { findings: [], couldNotCheck: [] },
    });
  });

  it("asks only GET, only the registered host, only the key pages, and never sends a query string or a key", async () => {
    const r = await run([HOST, "--pagespeed", "--json", "--no-open", "--quiet"], {
      [HOME]: ok({ field: { lcp: GOOD, inp: GOOD, cls: GOOD } }),
    });
    const toGoogle = r.seen.filter((s) => s.url.includes("googleapis.com"));
    expect(toGoogle.length).toBeGreaterThan(0);
    expect(toGoogle.length).toBeLessThanOrEqual(5);
    expect(toGoogle.every((s) => s.method === "GET")).toBe(true);
    expect(toGoogle.every((s) => PAGESPEED_HOSTS.includes(new URL(s.url).hostname))).toBe(true);
    expect(r.asked[0]?.page).toBe(HOME);
    expect(r.asked.every((a) => !a.page?.includes("?") && !/key=/i.test(a.url))).toBe(true);
    expect(r.seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  });

  it("tells the person once, on stderr, that page addresses go to Google", async () => {
    const r = await run([HOST, "--pagespeed", "--no-open"], {
      [HOME]: ok({ field: { lcp: GOOD, inp: GOOD, cls: GOOD } }),
    });
    expect(r.err).toContain("--pagespeed sends the address of each page it reads");
    expect(r.err.match(/--pagespeed sends/g)).toHaveLength(1);
  });

  it("sends nothing to Google for an address on this computer", async () => {
    const out: string[] = [];
    let touched = false;
    const transport: Transport = (url) => {
      if (url.hostname.endsWith("googleapis.com")) touched = true;
      return Promise.reject(Object.assign(new Error("no"), { code: "ECONNREFUSED" }));
    };
    await main(
      ["http://127.0.0.1:9/", "--pagespeed", "--allow-private", "--json", "--no-open", "--quiet"],
      {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      { cwd: folder(), fetcher: { transport } } as never,
    );
    expect(touched).toBe(false);
  });
});

describe("--pagespeed: parsing, help and flags", () => {
  it("parses --pagespeed on the page check, off by default", () => {
    const a = parseCliArgs([HOST, "--pagespeed"], {});
    expect(a.kind === "run" && a.pagespeed).toBe(true);
    const b = parseCliArgs([HOST], {});
    expect(b.kind === "run" && b.pagespeed).toBe(false);
  });

  it("is in the flag table, a boolean on the page check, and in --help", () => {
    const f = FLAGS.find((x) => x.name === "pagespeed");
    expect(f?.type).toBe("boolean");
    expect(f?.commands).toEqual(["check"]);
    expect(HELP[""]).toContain("--pagespeed");
  });
});
