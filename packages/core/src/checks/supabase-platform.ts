import type { SupabaseRead } from "../adapters/supabase-mcp-read.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import {
  CheckRegistry,
  defineCheck,
  type Check,
  type CheckContext,
  type Finding,
} from "../model.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * The checks a Supabase platform read feeds (MCP-03, ADR-0008). They read what
 * adapters/supabase-mcp-read.ts kept (names, yes/no, counts, lint codes), never a description or a
 * row. Absence of evidence is never a pass: a read that stopped, a tool that was not read or a value
 * that is not a plain yes or no is could-not-check, with Gaugeline's own reason.
 */
export interface SupabasePlatformInput {
  read: SupabaseRead;
}

/** The lint Supabase's advisor raises for the same thing supabase-rls-off reports from the table list. */
const RLS_LINT = "rls_disabled_in_public";

const where = (r: SupabaseRead) => `supabase:${r.projectRef}`;

/** True when the read can be used for this tool; otherwise says why under the check, and false. */
function readable(r: SupabaseRead, tool: string, ctx: CheckContext): boolean {
  if (r.status !== "read") {
    ctx.couldNotCheck?.(where(r), r.reason ?? "Supabase was not read");
    return false;
  }
  const missed = r.notRead.find((n) => n.tool === tool);
  if (missed !== undefined) {
    ctx.couldNotCheck?.(where(r), missed.reason);
    return false;
  }
  return true;
}

export const supabaseRlsOff = defineCheck<SupabasePlatformInput>({
  id: "supabase-rls-off",
  size: "M",
  done: "Every table in the public schema has row-level security on, with policies for what visitors may read and write.",
  estimateChanges:
    "Turning it on is one statement per table; writing the policies the site needs is the work, and the site must be tested after.",
  area: "Security & email",
  severity: "high",
  title: "A Supabase table has row-level security off",
  what: "A table in the project's public schema has row-level security switched off.",
  why: "A site built on Supabase ships the project's public key to every visitor. Without row-level security on a public table, that key reaches every row of it through the Data API, unless the table's grants say otherwise: a booking list, a waitlist or an order table can be read, and often changed, by anyone.",
  fix: "In the Supabase dashboard, open the table and enable row-level security, then add a policy for each thing visitors should do (for example, insert their own booking, read the menu). Test the site after: a table with no policy refuses everything.",
  tech: "read through Supabase's hosted MCP server in read-only mode for the configured project only (list_tables with schemas [\"public\"], verbose false); a table whose rls_enabled is false is a finding; the evidence is the table's name, cleaned and cut to 40 characters, and its row estimate; a table whose rls_enabled is not a boolean, an unread tool or a stopped read is could-not-check",
  run(input, ctx) {
    const r = input.read;
    if (!readable(r, "list_tables", ctx) || r.tables === undefined) return [];
    if (r.tables.some((t) => typeof t.rls_enabled !== "boolean"))
      ctx.couldNotCheck?.(
        where(r),
        "a table's row-level security setting was not a plain yes or no",
      );
    return r.tables.flatMap((t): Finding[] =>
      t.rls_enabled === false
        ? [
            {
              checkId: "supabase-rls-off",
              severity: "high",
              title: this.title,
              evidence: `${escapeInvisible(t.name ?? "an unnamed table", 60)}: row-level security is off${t.rows === undefined ? "" : ` (about ${t.rows} rows)`}.`,
              url: `${where(r)}:${escapeInvisible(t.name ?? "unnamed", 60)}`,
            },
          ]
        : [],
    );
  },
});

export const supabaseSecurityAdvisor = defineCheck<SupabasePlatformInput>({
  id: "supabase-security-advisor",
  size: "M",
  done: "Supabase's security advisor shows no ERROR or WARN lint for the project.",
  estimateChanges:
    "Each lint names its own fix; some are one setting, some change how a function or a view is written.",
  area: "Security & email",
  severity: "medium",
  title: "Supabase's security advisor reports a problem",
  what: "Supabase's own security advisor reports a lint at ERROR or WARN level for the project.",
  why: "The advisor is Supabase's own reading of the project's security settings. A lint left open is a known weakness in the database behind the site, found by the vendor and waiting for someone to act.",
  fix: "Open Advisors, then Security Advisor, in the Supabase dashboard; each lint links to its remediation page. Fix the ERROR ones first.",
  tech: "read through Supabase's hosted MCP server in read-only mode (get_advisors with type security); only each lint's code (a lower-case id), level and facing are kept, never its title, description or remediation text; lints are grouped by code and level, INFO is not reported, and rls_disabled_in_public is left to supabase-rls-off when the table list was read",
  run(input, ctx) {
    const r = input.read;
    if (!readable(r, "get_advisors", ctx) || r.advisors === undefined) return [];
    const tablesRead = r.tables !== undefined;
    const counts = new Map<string, number>();
    for (const lint of r.advisors) {
      if (lint.level !== "ERROR" && lint.level !== "WARN") continue;
      if (lint.name === RLS_LINT && tablesRead) continue;
      const label =
        lint.name === undefined
          ? `an unnamed lint (${lint.level})`
          : `${lint.name} (${lint.level}${lint.facing ? `, facing ${lint.facing}` : ""})`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, n]): Finding => ({
      checkId: "supabase-security-advisor",
      severity: "medium",
      title: this.title,
      evidence: `Supabase's security advisor reports ${label} ${n} ${n === 1 ? "time" : "times"}.`,
      url: where(r),
    }));
  },
});

/** The checks `gaugeline platform` runs for a Supabase entry. They read a SupabasePlatformInput, not a page. */
export const SUPABASE_PLATFORM_CHECKS: readonly Check<SupabasePlatformInput>[] = [
  supabaseRlsOff,
  supabaseSecurityAdvisor,
];

export function createSupabasePlatformRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of SUPABASE_PLATFORM_CHECKS) registry.register(c);
  return registry;
}

/** Read the project and run the checks. A missing token reads as not-configured; the caller says what to set. */
export async function runSupabasePlatform(options: {
  fetcher: Fetcher;
  env: Env;
  projectRef: string;
  now: Date;
}): Promise<{ read: SupabaseRead; result: Result }> {
  // The read is an adapter module, reached only by a dynamic import (the loader rule).
  const { MAX_TABLES, readSupabase } = await import("../adapters/supabase-mcp-read.js");
  const read = await readSupabase(options);
  const checked = await runChecks({ read }, createSupabasePlatformRegistry());
  // A list over its cap is not read at all (could-not-check), so what was read is what was seen.
  const tables = read.tables?.length;
  return {
    read,
    result: buildResult({
      url: `platform:supabase:${read.projectRef}`,
      startedAt: options.now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
      sampled:
        tables === undefined
          ? {}
          : { "supabase-tables": { seen: tables, taken: tables, limit: MAX_TABLES } },
    }),
  };
}
