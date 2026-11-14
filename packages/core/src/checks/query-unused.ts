import { CheckRegistry, defineCheck, type Check } from "../model.js";
import type { QueryInput } from "./query-counts.js";

/** What the check says in a list: the finding itself names the field. */
export const UNUSED_TITLE = "A query fetches a field the code never reads";

const TECH =
  'read from the repository with no request and no key: each groq template, defineQuery call and gql template is read into a tree of the fields it returns, named by alias ("slug": slug.current is slug), and the TypeScript compiler\'s symbols follow the result through variables, await, destructuring, props passed to components, map callbacks, returns and spreads into JSX props; a field counts as read when a property access or a destructuring reads its alias on a value that came from the query, held in a Map from query to the Set of aliases read, so unused is the aliases projected minus the aliases read; _id, _type, _key and _rev are never reported; a query whose result escapes (JSON.stringify, a function from a package, a field read by a name only known at run time) is listed as could not follow and none of its fields is reported';

export const queryFieldUnused = defineCheck<QueryInput>({
  id: "query-field-unused",
  size: "S",
  done: "The field is out of the query, unless a script or another repository uses it.",
  estimateChanges:
    "Gaugeline cannot see other repositories, so someone has to check before the field is dropped.",
  area: "Visitors",
  severity: "medium",
  title: UNUSED_TITLE,
  what: "A query in your code asks for a field, and nothing that receives the result ever reads it.",
  why: "Every field you ask for is data your visitors download and your server waits for, and nobody sees it. Over a few months a query collects fields from pages that changed, and the page gets slower for content it never shows.",
  fix: "Open the file and line named and take the field out of the query, unless something Gaugeline cannot read (a script, another repository) uses it. A query listed as could not follow was left alone on purpose: its result goes somewhere Gaugeline cannot read, so none of its fields were reported.",
  tech: TECH,
  run: (input, ctx) => {
    const unused = input.unused;
    if (unused === undefined) return [];
    for (const c of unused.couldNotFollow)
      ctx.couldNotCheck?.(`${c.source.file}:${c.source.line}`, c.reason);
    return [...unused.findings];
  },
});

/** The check `gaugeline query --unused` runs. It reads the analysis in a QueryInput. */
export const QUERY_UNUSED_CHECKS: readonly Check<QueryInput>[] = [queryFieldUnused];

/** Only the unused-field check: `--unused` is its own run. */
export function createUnusedRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of QUERY_UNUSED_CHECKS) registry.register(c);
  return registry;
}
