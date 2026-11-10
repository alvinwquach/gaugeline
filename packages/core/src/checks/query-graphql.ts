import { CheckRegistry, defineCheck, type Check } from "../model.js";
import { GRAPHQL_TITLES, checkGraphql } from "../query/graphql.js";
import type { QueryInput } from "./query-counts.js";

const TECH =
  "read from the repository with no request for the documents: .graphql and .gql files and gql tagged templates are read into a field use for each field (its parent type, its path from the operation, its file and line), fragments are resolved by name, and each use is one Map lookup (type name to the Set of its field names) in the schema; the schema is one GET of the endpoint's introspection query with the query in the address (or a file given with --schema); mutations and subscriptions are parsed and counted, and never sent";

export const graphqlFieldNotInSchema = defineCheck<QueryInput>({
  id: "graphql-field-not-in-schema",
  area: "Visitors",
  severity: "high",
  title: GRAPHQL_TITLES.notInSchema,
  what: "A GraphQL query in your code asks for a field that the schema does not have on that type.",
  why: "The server answers the whole query with an error, or leaves the field out, and the page that asked for it renders empty. It is the usual result of a renamed or removed field: the query still compiles, and nobody sees the gap until a customer does.",
  fix: "Open the file and line named, and find what the field is called in the schema now (the schema file, or the GraphQL playground) and change the query. Ask Gaugeline again to confirm.",
  tech: `${TECH}; a field use whose parent type is in the schema and whose name is in neither that type's fields nor, for an interface or a union, the fields of any type it can be`,
  run: (input) =>
    input.graphql === undefined ? [] : checkGraphql(input.graphql.uses, input.graphql.schema),
});

/** The check `gaugeline query --graphql` adds. */
export const GRAPHQL_CHECKS: readonly Check<QueryInput>[] = [graphqlFieldNotInSchema];

/** Just the GraphQL check: for a run that reads no dataset. */
export function createGraphqlRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of GRAPHQL_CHECKS) registry.register(c);
  return registry;
}
