import {
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  compareGraphql,
  createFetcher,
  defaultGraphqlEndpoint,
  displayEndpoint,
  extractGraphql,
  freezeEnv,
  graphqlToken,
  introspect,
  isDocumentType,
  isSanityHost,
  parseSanityEndpoint,
  readGraphqlSchemaFile,
  type FetcherOptions,
  type GqlSchema,
  type Outcome,
  type Unreadable,
} from "@gaugeline/core";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

/** Why each GraphQL document that could not be read was left alone, in a sentence a person can act on. */
const WHY: Record<Unreadable["reason"], string> = {
  concatenated:
    "built from something other than a gql template (an interpolated string or call), so it cannot be read from the file",
  "parse-error":
    "could not be parsed: the file has a syntax error, or the text is not valid GraphQL",
  "no-type-filter": "no document type to attribute it to",
  "unknown-fragment": "spreads a fragment that no file that was read defines",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

interface Deps {
  cwd: string;
  now?: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
}

/** "1 mutation and 2 subscriptions", or "", for the line that says what was parsed and not sent. */
function writes(mutations: number, subscriptions: number): string {
  const parts = [
    ...(mutations > 0 ? [plural(mutations, "mutation")] : []),
    ...(subscriptions > 0 ? [plural(subscriptions, "subscription")] : []),
  ];
  return parts.join(" and ");
}

/**
 * gaugeline query <folder> --graphql [endpoint]: the GraphQL in a repository, checked against the
 * schema. The first line of output is the endpoint (or the schema file). The schema is one GET of
 * the endpoint's introspection query, or a file (--schema); a server that will not answer the GET
 * is exit 2 with the --schema hint, and nothing else is sent in its place. Then the field check,
 * and for a Sanity endpoint the same document types counted in the dataset. Mutations and
 * subscriptions are counted and never sent.
 */
export async function runGraphql(
  args: {
    dir: string;
    json?: boolean;
    graphql: { endpoint?: string };
    schema?: string;
    allowPrivate?: boolean;
    quiet?: boolean;
  },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const env = io.env ?? {};
  const notices: string[] = [];
  // Everything that can stop the command without a request comes before the first one.
  const fromFile =
    args.schema === undefined
      ? undefined
      : await readGraphqlSchemaFile(resolve(deps.cwd, args.schema));
  let endpoint: string | undefined;
  if (fromFile === undefined) {
    if (args.graphql.endpoint !== undefined) endpoint = args.graphql.endpoint;
    else {
      const chosen = defaultGraphqlEndpoint(env);
      endpoint = chosen.endpoint;
      if (chosen.datasetAssumed)
        notices.push(
          'SANITY_DATASET is not set, so the dataset "production" was assumed. Set it if your content lives in another dataset.',
        );
    }
  }
  const found = await extractGraphql(resolve(deps.cwd, args.dir));
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = typed === "." ? "" : typed;
  const shown = (file: string): string => (prefix === "" ? file : `${prefix}/${file}`);
  const at = <T extends { file: string; line: number }>(s: T): T => ({ ...s, file: shown(s.file) });
  const uses = found.uses.map((u) => ({ ...u, source: at(u.source), root: at(u.root) }));
  const unreadable = found.unreadable.map((u) => ({ ...u, source: at(u.source) }));

  let schema: GqlSchema;
  if (fromFile !== undefined) schema = fromFile;
  else {
    const fetcher = createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate === true ? { allowPrivate: true } : {}),
    });
    const token = graphqlToken(endpoint as string, env);
    schema = await introspect(endpoint as string, token.value, fetcher);
  }

  // The content count step: Sanity only, because only Sanity's documents can be counted.
  let count: { env: Record<string, string | undefined> } | undefined;
  let skipped: string | undefined;
  const sanityEnv = (projectId: string, dataset: string): Record<string, string | undefined> => ({
    ...freezeEnv(env, [SANITY_TOKEN]),
    [SANITY_PROJECT_ID]: projectId,
    [SANITY_DATASET]: dataset,
  });
  if (endpoint !== undefined) {
    const sanity = parseSanityEndpoint(endpoint);
    if (sanity) count = { env: sanityEnv(sanity.projectId, sanity.dataset) };
    else if (isSanityHost(endpoint))
      skipped =
        "The address does not name a Sanity dataset, so the queries were not compared with your content.";
    else
      skipped =
        "This is not a Sanity endpoint, so the content counts were skipped: only a Sanity dataset can be counted.";
  } else if ([...schema.fields.keys()].some((t) => isDocumentType(schema, t))) {
    const project = (env[SANITY_PROJECT_ID] ?? "").trim();
    if (project === "")
      skipped =
        "SANITY_PROJECT_ID is not set, so the queries were not compared with your content. Set it (and SANITY_TOKEN, with the Viewer role, for a private dataset) to count the documents.";
    else count = { env: freezeEnv(env, [SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN]) };
  } else {
    skipped =
      "The schema has no Sanity document types (types that implement Document), so there was nothing to count.";
  }

  const now = deps.now ?? new Date();
  const run = await compareGraphql({
    uses,
    schema,
    ...(count
      ? {
          sanity: {
            env: count.env,
            fetcher: createFetcher({
              ...deps.fetcher,
              ...(args.allowPrivate === true ? { allowPrivate: true } : {}),
            }),
          },
        }
      : {}),
    now,
  });
  if (args.quiet !== true) for (const n of [...notices, ...run.notices]) io.stderr.write(`${n}\n`);
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run.result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }

  const out: string[] = [
    endpoint === undefined
      ? `GraphQL  schema from ${args.schema as string}`
      : `GraphQL  ${displayEndpoint(endpoint)}`,
  ];
  const total = found.queries + found.fragments;
  out.push(
    total === 0 && unreadable.length === 0
      ? `No GraphQL found under ${args.dir}. It looks for .graphql and .gql files and gql and graphql tagged templates in .ts, .tsx, .js, .jsx and .mjs files, and skips node_modules, .next, dist and what .gitignore names.`
      : `Read ${plural(found.queries, "query", "queries")} and ${plural(found.fragments, "fragment")} in ${plural(found.files, "file")}: ${plural(uses.length, "field")} checked against the schema.`,
  );
  const sent = writes(found.mutations.length, found.subscriptions.length);
  out.push(
    sent === ""
      ? "No mutations or subscriptions found."
      : `Found ${sent}. They were parsed and counted, and never sent.`,
  );
  if (unreadable.length > 0) {
    out.push("", `Could not read ${plural(unreadable.length, "document")}:`);
    for (const u of unreadable)
      out.push(`  ${u.source.file}:${u.source.line}  ${u.reason}: ${WHY[u.reason]}`);
  }
  if (skipped !== undefined) out.push("", skipped);
  else if (run.types > 0)
    out.push(
      "",
      `Counted the published documents of ${plural(run.types, "type")} in the dataset: one request each, counts only.`,
    );
  else if (count !== undefined)
    out.push(
      "",
      "None of the queries ask for a Sanity document type, so there was nothing to count.",
    );
  out.push(
    "",
    formatTerminal({
      result: {
        findings: run.result.findings,
        passed: run.result.passed,
        failed: [],
        warnings: [],
        couldNotCheck: run.result.couldNotCheck,
        sampled: {},
      },
      color: deps.color ?? false,
    }).trimEnd(),
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}
