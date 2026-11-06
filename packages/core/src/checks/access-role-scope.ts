import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

const COLUMNS_SHOWN = 8;

export const accessRoleScope = defineCheck<PageSnapshot>({
  id: "access-role-scope",
  area: "Security & email",
  severity: "high",
  title: "A signed-in user can read other people's rows",
  what: "Signed in as a test user, Gaugeline can read rows of a table that belong to someone else, by the owner column set in gaugeline.access.json.",
  why: "Any customer who signs up can read every other customer's records, and nobody sees it from the site.",
  fix: "Change the table's read policy so a user sees only rows where the owner column is their own id (auth.uid()).",
  tech: "Supabase: per configured test user and per table with an owner column, one HEAD /rest/v1/<table>?select=*&<owner>=neq.<user id> with that user's token and Prefer: count=exact; a count above 0 is a finding. Tokens come from the environment and are only ever sent in the Authorization header",
  async run(page, ctx) {
    if (!ctx.access) return [];
    const read = await ctx.access();
    const columns = new Map(read.tables.map((t) => [t.name, t.columns]));
    return read.scoped
      .filter((s) => s.state === "readable")
      .map((s) => {
        const cols = columns.get(s.table) ?? [];
        return {
          checkId: "access-role-scope",
          severity: "high" as const,
          title: this.title,
          evidence: `as ${s.role}, ${s.table}: ${s.count ?? 0} rows whose ${s.owner} is someone else's are readable${cols.length > 0 ? `; columns: ${firstFew(cols, COLUMNS_SHOWN)}` : ""}`,
          url: `${read.url}/rest/v1/${s.table}`,
        };
      });
  },
});
