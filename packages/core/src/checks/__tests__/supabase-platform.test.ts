import { describe, expect, it } from "vitest";
import type { SupabaseRead } from "../../adapters/supabase-mcp-read.js";
import { fakeSupabase } from "@gaugeline/testkit";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { COULD_NOT_CHECK } from "../../sources/mcp-guard.js";
import {
  SUPABASE_PLATFORM_CHECKS,
  createSupabasePlatformRegistry,
  runSupabasePlatform,
} from "../supabase-platform.js";

/** The checks a Supabase platform read feeds. Every project, table and lint is invented. */
const REF = "abcdefghijklmnopqrst";
const read = (over: Partial<SupabaseRead> = {}): SupabaseRead => ({
  status: "read",
  projectRef: REF,
  calls: 6,
  tables: [
    { name: "public.bookings", rls_enabled: false, rows: 214 },
    { name: "public.menu_items", rls_enabled: true, rows: 38 },
  ],
  advisors: [
    { name: "rls_disabled_in_public", level: "ERROR", facing: "EXTERNAL" },
    { name: "function_search_path_mutable", level: "WARN", facing: "EXTERNAL" },
    { name: "function_search_path_mutable", level: "WARN", facing: "EXTERNAL" },
    { name: "unused_index", level: "INFO", facing: "EXTERNAL" },
  ],
  migrations: { count: 2, latest: "20261101093000" },
  notRead: [],
  ...over,
});
const run = (r: SupabaseRead) => runChecks({ read: r }, createSupabasePlatformRegistry());

describe("supabase-rls-off", () => {
  it("reports each public table with row-level security off, by name and row count", async () => {
    const out = await run(read());
    const rls = out.findings.filter((f) => f.checkId === "supabase-rls-off");
    expect(rls).toHaveLength(1);
    expect(rls[0]).toMatchObject({
      severity: "high",
      evidence: "public.bookings: row-level security is off (about 214 rows).",
      url: `supabase:${REF}:public.bookings`,
    });
  });

  it("passes only when every table says yes", async () => {
    const out = await run(read({ tables: [{ name: "public.menu_items", rls_enabled: true }] }));
    expect(out.passed).toContain("supabase-rls-off");
  });

  it("is could-not-check, never a pass, for an odd value, an unread tool or a stopped read", async () => {
    const odd = await run(read({ tables: [{ name: "public.guests" }] }));
    expect(odd.passed).not.toContain("supabase-rls-off");
    expect(odd.couldNotCheck.map((c) => c.id)).toContain("supabase-rls-off");
    const unread = await run(
      read({
        tables: undefined,
        notRead: [{ tool: "list_tables", reason: COULD_NOT_CHECK.changed }],
      }),
    );
    expect(unread.couldNotCheck).toContainEqual({
      id: "supabase-rls-off",
      reason: COULD_NOT_CHECK.changed,
      url: `supabase:${REF}`,
    });
    const stopped = await run(
      read({
        status: "could-not-check",
        reason: COULD_NOT_CHECK.sessionNotReadOnly,
        tables: undefined,
      }),
    );
    expect(stopped.passed).toEqual([]);
    expect(stopped.couldNotCheck.map((c) => c.reason)).toEqual([
      COULD_NOT_CHECK.sessionNotReadOnly,
      COULD_NOT_CHECK.sessionNotReadOnly,
    ]);
  });
});

describe("supabase-security-advisor", () => {
  it("reports each ERROR or WARN lint once with its count; INFO and a lint the table check covers are not repeated", async () => {
    const out = await run(read());
    const adv = out.findings.filter((f) => f.checkId === "supabase-security-advisor");
    expect(adv.map((f) => f.evidence)).toEqual([
      "Supabase's security advisor reports function_search_path_mutable (WARN, facing EXTERNAL) 2 times.",
    ]);
  });

  it("keeps the RLS lint when the table list was not read", async () => {
    const out = await run(
      read({
        tables: undefined,
        notRead: [{ tool: "list_tables", reason: COULD_NOT_CHECK.changed }],
      }),
    );
    expect(out.findings.map((f) => f.evidence).join("\n")).toContain(
      "rls_disabled_in_public (ERROR",
    );
  });

  it("does not print a lint whose name was dropped as unsafe", async () => {
    const out = await run(read({ advisors: [{ level: "ERROR" }] }));
    expect(out.findings.filter((f) => f.checkId === "supabase-security-advisor")[0]?.evidence).toBe(
      "Supabase's security advisor reports an unnamed lint (ERROR) 1 time.",
    );
  });
});

describe("runSupabasePlatform, end to end against the fake server", () => {
  it("reads and checks, and the result holds no token and no description", async () => {
    const token = ["sbp", "_", "fake", "0123456789abcdef"].join("");
    const fake = fakeSupabase();
    const out = await runSupabasePlatform({
      fetcher: createFetcher({ transport: fake.transport }),
      env: { SUPABASE_ACCESS_TOKEN: token },
      projectRef: REF,
      now: new Date("2026-11-12T10:00:00Z"),
    });
    expect(out.read.status).toBe("read");
    expect(out.result.findings.map((f) => f.checkId)).toEqual([
      "supabase-rls-off",
      "supabase-security-advisor",
    ]);
    expect(out.result.sampled["supabase-tables"]).toEqual({ seen: 2, taken: 2, limit: 500 });
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${token}|Friday|RLS Disabled`));
  });

  it("registers two checks with the four texts the reference prints", () => {
    expect(SUPABASE_PLATFORM_CHECKS.map((c) => c.id)).toEqual([
      "supabase-rls-off",
      "supabase-security-advisor",
    ]);
    for (const c of SUPABASE_PLATFORM_CHECKS)
      for (const f of ["what", "why", "fix", "tech"] as const)
        expect(c[f].length).toBeGreaterThan(20);
  });
});
