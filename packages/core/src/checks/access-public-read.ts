import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

/** Columns shown in evidence: names only, the first few. */
const COLUMNS_SHOWN = 8;

export const accessPublicRead = defineCheck<PageSnapshot>({
  id: "access-public-read",
  area: "Security & email",
  severity: "high",
  title: "Anyone can read a table you didn't make public",
  what: "Your database answers anonymous visitors with rows from a table that gaugeline.access.json doesn't list as public.",
  why: "The project's public key is in your site's code by design, so anyone can use it to download every row of that table: orders, emails, whatever it holds.",
  fix: "Turn on row level security for the table and add a policy that allows only what visitors need, or mark the table public in gaugeline.access.json if it really is.",
  tech: "Supabase: the exposed tables from PostgREST's OpenAPI description (GET /rest/v1/), then one HEAD /rest/v1/<table>?select=* per table with the anon key and Prefer: count=exact (at most 20); the count comes from Content-Range and no row is downloaded. Readable and empty is not a finding",
  async run(page, ctx) {
    if (!ctx.access) return [];
    const read = await ctx.access();
    const isPublic = new Set(read.publicTables);
    return read.tables
      .filter((t) => t.anon.state === "readable" && !isPublic.has(t.name))
      .map((t) => ({
        checkId: "access-public-read",
        severity: "high" as const,
        title: this.title,
        evidence: `${t.name}${t.kind === "view" ? " (a view)" : ""}: ${t.anon.count ?? 0} rows readable without signing in${t.columns.length > 0 ? `; columns: ${firstFew(t.columns, COLUMNS_SHOWN)}` : ""}`,
        url: `${read.url}/rest/v1/${t.name}`,
      }));
  },
});
