import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type * as TS from "typescript";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  connectorGet,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import {
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  sanitySettings,
} from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import type { Finding } from "../model.js";
import {
  GqlSyntaxError,
  parseGraphql,
  type GqlDefinition,
  type GqlFragment,
  type GqlOperation,
  type GqlSelection,
} from "./graphql-parse.js";
import type { FieldUse, QueryShape, SourceRef, Unreadable } from "./shape.js";
import {
  SCRIPT_KINDS,
  firstSyntaxError,
  importTypeScript,
  loadCompiler,
  sourceRoot,
  walk,
  withoutBom,
  type TypeScript,
} from "./source.js";

/**
 * `gaugeline query --graphql`: the GraphQL documents in a repository (.graphql and .gql files and
 * gql tagged templates), read into the fields each one asks for, and compared with the schema.
 *
 * Read only. A mutation or a subscription in a document is parsed and counted and nothing more:
 * no text of any document ever reaches a request, because the one request this module makes, the
 * introspection query, is a constant, and it is a GET (GraphQL over HTTP allows a query over GET
 * and forbids a mutation over it). A server that will not answer the GET is not asked another way:
 * the person gives a schema file instead.
 */

/** The environment variable that holds a token for an endpoint that is not Sanity's. */
export const GRAPHQL_TOKEN = "GRAPHQL_TOKEN";

/** One step from the root of an operation down to a field: the field, and the type condition that held it. */
export interface GqlStep {
  field: string;
  /** The type named by the `... on T` or fragment this field sat in; "" when there was none. */
  on: string;
}

/** One field a document asks for. */
export interface GqlFieldUse {
  /**
   * The type the field was asked on, when the document says so: the type of the fragment or `...
   * on` it sits in. "" when the document does not say, and the type is the one the fields above it
   * lead to (see `chain`), which only the schema can tell.
   */
  parent: string;
  field: string;
  /** "allResource.author": the fields from the operation down to this one. A fragment's own fields start with "...Name". */
  path: string;
  /**
   * Where the field is written: the file and the line the operation or fragment that holds it
   * starts on (as a GROQ query's line is where the query starts). The path says which field.
   */
  source: SourceRef;
  /** The fields from the root of the operation (or the start of a fragment) down to the one holding this field. */
  chain: readonly GqlStep[];
  /** True when the field has no selection of its own: a value the page reads. */
  leaf: boolean;
  /** The operation the field was reached from (or the fragment, when no query reaches it): what the content counts are shaped by. */
  root: SourceRef;
}

/** What was read from a folder's GraphQL documents. */
export interface GraphqlExtraction {
  uses: GqlFieldUse[];
  /** Every mutation operation found. Parsed and counted; never sent. */
  mutations: SourceRef[];
  /** Every subscription operation found. Parsed and counted; never sent. */
  subscriptions: SourceRef[];
  unreadable: Unreadable[];
  /** Query operations, fragments and files with at least one document, for the line that says what was read. */
  queries: number;
  fragments: number;
  files: number;
}

export interface GraphqlExtractOptions {
  /** Tests: how the TypeScript compiler is loaded. */
  loadTypeScript?: () => Promise<TypeScript>;
}

/**
 * What a schema says, in the structures the checks need. `fields` is the membership Map the rule
 * asks (is this field on this type: one Map lookup, one Set lookup); `returns` says what type each
 * field leads to, which the walk down a query needs and a Map of names alone cannot give.
 */
export interface GqlSchema {
  /** Object and interface types (and unions, with no fields) by name, to the names of their fields. */
  fields: Map<string, Set<string>>;
  /** Type name to field name to the type that field returns and whether it is a list. */
  returns: Map<string, Map<string, { type: string; list: boolean }>>;
  /** An interface or union to the types it can be at run time. */
  possible: Map<string, Set<string>>;
  /** An object or interface to the interfaces it implements. */
  implementsOf: Map<string, Set<string>>;
  /** The root of a query: `Query`, or what `schema { query: ... }` names (Sanity's is `RootQuery`). */
  queryType: string;
}

const GRAPHQL_FILES = new Set([".graphql", ".gql"]);
const GQL_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".graphql", ".gql"]);

/** A document read from a file or a template, before its fragments are resolved. */
interface Doc {
  file: string;
  line: number;
  text: string;
}

interface TemplateDoc extends Doc {
  /** Names interpolated into the template that must be gql templates elsewhere. */
  refs: string[];
  /** An interpolation that is not a name: a string, a call, anything the file does not settle. */
  other: boolean;
}

const isGqlTag = (ts: TypeScript, tag: TS.Expression): boolean =>
  (ts.isIdentifier(tag) && (tag.text === "gql" || tag.text === "graphql")) ||
  (ts.isPropertyAccessExpression(tag) && (tag.name.text === "gql" || tag.name.text === "graphql"));

/** The gql templates in one TypeScript or JavaScript file, and the names bound to a gql template in it. */
function readTemplates(
  ts: TypeScript,
  file: string,
  source: string,
): { templates: TemplateDoc[]; bound: Set<string>; syntaxError: number | null } {
  const text = withoutBom(source);
  const kind = SCRIPT_KINDS(ts)[extname(file).toLowerCase()] ?? ts.ScriptKind.TS;
  const out = {
    templates: [] as TemplateDoc[],
    bound: new Set<string>(),
    syntaxError: null as number | null,
  };
  const bad = firstSyntaxError(ts, file, text);
  if (bad !== null) {
    out.syntaxError = bad;
    return out;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: TS.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const unwrap = (e: TS.Expression): TS.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    )
      cur = cur.expression;
    return cur;
  };
  const isGqlTemplate = (e: TS.Expression | undefined): boolean => {
    if (!e) return false;
    const x = unwrap(e);
    return ts.isTaggedTemplateExpression(x) && isGqlTag(ts, x.tag);
  };

  const visit = (node: TS.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isGqlTemplate(node.initializer)
    )
      out.bound.add(node.name.text);
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      isGqlTemplate(node.initializer)
    )
      out.bound.add(node.name.text);
    if (ts.isTaggedTemplateExpression(node) && isGqlTag(ts, node.tag)) {
      const tpl = node.template;
      if (ts.isNoSubstitutionTemplateLiteral(tpl)) {
        out.templates.push({ file, line: lineOf(tpl), text: tpl.text, refs: [], other: false });
      } else {
        let joined = tpl.head.text;
        const refs: string[] = [];
        let other = false;
        for (const span of tpl.templateSpans) {
          const e = unwrap(span.expression);
          if (ts.isIdentifier(e)) refs.push(e.text);
          else if (ts.isPropertyAccessExpression(e)) refs.push(e.name.text);
          else if (!isGqlTemplate(e)) other = true;
          // The interpolation is taken out of the text, and its lines kept, so a line number is still the file's.
          joined +=
            "\n".repeat(
              text.slice(span.expression.getFullStart(), span.literal.getStart(sf)).split("\n")
                .length - 1,
            ) + span.literal.text;
        }
        out.templates.push({ file, line: lineOf(tpl), text: joined, refs, other });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

interface Parsed {
  operations: Array<GqlOperation & { file: string }>;
  fragments: Map<string, GqlFragment & { file: string }>;
  fragmentList: Array<GqlFragment & { file: string }>;
}

/** What `kind` reads from a definition list, with the file each came from. */
function collect(defs: readonly GqlDefinition[], file: string, into: Parsed): void {
  for (const d of defs) {
    if (d.kind === "operation") into.operations.push({ ...d, file });
    else if (d.kind === "fragment") {
      const f = { ...d, file };
      // A name defined twice is a mistake the server would refuse; the first one is read.
      if (!into.fragments.has(f.name)) into.fragments.set(f.name, f);
      into.fragmentList.push(f);
    }
  }
}

const chainKey = (chain: readonly GqlStep[]): string =>
  chain.map((s) => `${s.on}:${s.field}`).join("/");

/**
 * Read the GraphQL documents under `dir` into the fields they ask for. Reads `.graphql` and `.gql`
 * files, and gql and graphql tagged templates in .ts, .tsx, .js, .jsx and .mjs files with the
 * TypeScript compiler. Fragments are resolved across files by name, and a fragment interpolated
 * into a template (`${AUTHOR}`) is resolved when the name is bound to a gql template. A template
 * built from anything else, a document that does not parse and a fragment nobody defines are
 * listed in `unreadable` with where they are, and never guessed.
 */
export async function extractGraphql(
  dir: string,
  options: GraphqlExtractOptions = {},
): Promise<GraphqlExtraction> {
  const root = await sourceRoot(dir);
  const ts = await loadCompiler(options.loadTypeScript ?? importTypeScript);
  const unreadable: Unreadable[] = [];
  const docs: Doc[] = [];
  const templates: TemplateDoc[] = [];
  const bound = new Set<string>();
  const filesWithDocs = new Set<string>();

  for (const file of await walk(root, GQL_EXTENSIONS)) {
    const text = await readFile(join(root, file), "utf8");
    if (GRAPHQL_FILES.has(extname(file).toLowerCase())) {
      docs.push({ file, line: 1, text: withoutBom(text) });
      continue;
    }
    // Most files in a repository say nothing of GraphQL: only the ones that name it are read as code.
    if (!/gql|graphql/i.test(text)) continue;
    const found = readTemplates(ts, file, text);
    if (found.syntaxError !== null) {
      unreadable.push({ reason: "parse-error", source: { file, line: found.syntaxError } });
      continue;
    }
    templates.push(...found.templates);
    for (const n of found.bound) bound.add(n);
  }

  for (const t of templates) {
    if (t.other || t.refs.some((r) => !bound.has(r)))
      unreadable.push({ reason: "concatenated", source: { file: t.file, line: t.line } });
    else docs.push(t);
  }

  // The same file and line, in the same order every run.
  docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const parsed: Parsed = { operations: [], fragments: new Map(), fragmentList: [] };
  for (const d of docs) {
    try {
      const defs = parseGraphql(d.text, d.line);
      if (defs.some((x) => x.kind === "operation" || x.kind === "fragment"))
        filesWithDocs.add(d.file);
      collect(defs, d.file, parsed);
    } catch (err) {
      if (!(err instanceof GqlSyntaxError)) throw err;
      unreadable.push({ reason: "parse-error", source: { file: d.file, line: err.line } });
    }
  }

  const uses: GqlFieldUse[] = [];
  const mutations: SourceRef[] = [];
  const subscriptions: SourceRef[] = [];
  const reached = new Set<string>();
  const missing = new Set<string>();
  let queries = 0;

  const walkSelections = (
    def: SourceRef,
    selections: readonly GqlSelection[],
    chain: readonly GqlStep[],
    on: string,
    top: SourceRef,
    prefix: string,
    seen: Set<string>,
  ): void => {
    for (const sel of selections) {
      if (sel.kind === "field") {
        // __typename, __schema and __type are the server's own, in every schema.
        if (sel.name.startsWith("__")) continue;
        uses.push({
          parent: on,
          field: sel.name,
          path: [...(prefix === "" ? [] : [prefix]), ...chain.map((s) => s.field), sel.name].join(
            ".",
          ),
          source: def,
          chain,
          leaf: sel.selections === undefined,
          root: top,
        });
        if (sel.selections)
          walkSelections(
            def,
            sel.selections,
            [...chain, { field: sel.name, on }],
            "",
            top,
            prefix,
            seen,
          );
      } else if (sel.kind === "inline") {
        walkSelections(def, sel.selections, chain, sel.typeCondition ?? on, top, prefix, seen);
      } else {
        const frag = parsed.fragments.get(sel.name);
        if (!frag) {
          const key = `${def.file}:${sel.line}`;
          if (!missing.has(key)) {
            missing.add(key);
            unreadable.push({
              reason: "unknown-fragment",
              source: { file: def.file, line: sel.line },
            });
          }
          continue;
        }
        reached.add(frag.name);
        // The same fragment at the same place is read once: that also ends a fragment that spreads itself.
        const key = `${frag.name}|${chainKey(chain)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        walkSelections(
          { file: frag.file, line: frag.line },
          frag.selections,
          chain,
          frag.typeCondition,
          top,
          prefix,
          seen,
        );
      }
    }
  };

  for (const op of parsed.operations) {
    const at = { file: op.file, line: op.line };
    if (op.operation === "mutation") mutations.push(at);
    else if (op.operation === "subscription") subscriptions.push(at);
    else {
      queries++;
      walkSelections(at, op.selections, [], "", at, "", new Set());
    }
  }
  // A fragment no query reaches is still checked on the type it names.
  for (const frag of parsed.fragmentList) {
    if (reached.has(frag.name) || parsed.fragments.get(frag.name) !== frag) continue;
    const at = { file: frag.file, line: frag.line };
    walkSelections(
      at,
      frag.selections,
      [],
      frag.typeCondition,
      at,
      `...${frag.name}`,
      new Set([`${frag.name}|`]),
    );
  }
  return {
    uses,
    mutations,
    subscriptions,
    unreadable,
    queries,
    fragments: parsed.fragmentList.length,
    files: filesWithDocs.size,
  };
}

// ---------------------------------------------------------------------------------------------
// The schema

const emptySchema = (queryType: string): GqlSchema => ({
  fields: new Map(),
  returns: new Map(),
  possible: new Map(),
  implementsOf: new Map(),
  queryType,
});

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The type a type reference leads to, and whether a list is on the way: `[Post!]!` is Post, a list. */
function unwrapRef(ref: unknown): { type: string; list: boolean } | null {
  let cur = record(ref);
  let list = false;
  for (let depth = 0; cur && depth < 20; depth++) {
    if (cur.kind === "LIST") list = true;
    if (typeof cur.name === "string" && cur.name !== "") return { type: cur.name, list };
    cur = record(cur.ofType);
  }
  return null;
}

/** The names in a list of `{ name }` objects. */
const namesOf = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.flatMap((x) => {
        const n = record(x)?.name;
        return typeof n === "string" ? [n] : [];
      })
    : [];

/** A schema from what a GraphQL introspection query answers: `{ data: { __schema } }` or `{ __schema }`. */
export function schemaFromIntrospection(json: unknown): GqlSchema {
  const top = record(json);
  const schema = record(record(top?.data)?.__schema ?? top?.__schema);
  if (!schema || !Array.isArray(schema.types))
    throw new Error("That is not the answer to an introspection query: it has no __schema.");
  const queryName = record(schema.queryType)?.name;
  const out = emptySchema(typeof queryName === "string" ? queryName : "Query");
  for (const raw of schema.types) {
    const t = record(raw);
    if (!t || typeof t.name !== "string") continue;
    const kind = t.kind;
    if (kind === "OBJECT" || kind === "INTERFACE") {
      const fields = new Set<string>();
      const returns = new Map<string, { type: string; list: boolean }>();
      for (const f of Array.isArray(t.fields) ? t.fields : []) {
        const fr = record(f);
        if (!fr || typeof fr.name !== "string") continue;
        fields.add(fr.name);
        const to = unwrapRef(fr.type);
        if (to) returns.set(fr.name, to);
      }
      out.fields.set(t.name, fields);
      out.returns.set(t.name, returns);
      const iface = new Set(namesOf(t.interfaces));
      if (iface.size > 0) out.implementsOf.set(t.name, iface);
    }
    if (kind === "UNION") out.fields.set(t.name, new Set());
    if (kind === "INTERFACE" || kind === "UNION")
      out.possible.set(t.name, new Set(namesOf(t.possibleTypes)));
  }
  return out;
}

/** A schema from SDL: the text of a `.graphql` schema file. Throws GqlSyntaxError when it is not GraphQL. */
export function schemaFromSdl(text: string): GqlSchema {
  const defs = parseGraphql(withoutBom(text));
  let query: string | undefined;
  for (const d of defs) {
    if (d.kind !== "schema") continue;
    query = d.query ?? query;
  }
  const out = emptySchema(query ?? "Query");
  for (const d of defs) {
    if (d.kind !== "type") continue;
    if (d.flavor === "union") {
      if (!out.fields.has(d.name)) out.fields.set(d.name, new Set());
      const members = out.possible.get(d.name) ?? new Set<string>();
      for (const m of d.members) members.add(m);
      out.possible.set(d.name, members);
      continue;
    }
    const fields = out.fields.get(d.name) ?? new Set<string>();
    const returns = out.returns.get(d.name) ?? new Map<string, { type: string; list: boolean }>();
    for (const f of d.fields) {
      fields.add(f.name);
      returns.set(f.name, { type: f.type, list: f.list });
    }
    out.fields.set(d.name, fields);
    out.returns.set(d.name, returns);
    if (d.implements.length > 0) {
      const set = out.implementsOf.get(d.name) ?? new Set<string>();
      for (const i of d.implements) set.add(i);
      out.implementsOf.set(d.name, set);
    }
    if (d.flavor === "interface" && !out.possible.has(d.name)) out.possible.set(d.name, new Set());
  }
  // An interface can be any type that says it implements it.
  for (const [type, interfaces] of out.implementsOf)
    for (const i of interfaces) {
      const set = out.possible.get(i) ?? new Set<string>();
      set.add(type);
      out.possible.set(i, set);
    }
  return out;
}

/** What `--schema <file>` can be: an SDL file or the JSON an introspection query returned. */
export function schemaFromText(text: string, label: string): GqlSchema {
  const plain = withoutBom(text);
  if (plain.trimStart().startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(plain);
    } catch {
      json = undefined;
    }
    if (json !== undefined) {
      try {
        return schemaFromIntrospection(json);
      } catch (err) {
        throw new ConfigError(`${label} is JSON, but not the answer to an introspection query.`, {
          hint: 'Pass an SDL file (schema.graphql), or the JSON a query for __schema returned ({ "data": { "__schema": ... } }).',
          cause: err,
        });
      }
    }
  }
  try {
    const schema = schemaFromSdl(plain);
    if (schema.fields.size === 0)
      throw new ConfigError(`${label} has no types in it, so it is not a schema.`, {
        hint: "Pass an SDL file with the schema's types (schema.graphql), or the JSON a GraphQL introspection query returned.",
      });
    return schema;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (!(err instanceof GqlSyntaxError)) throw err;
    throw new ConfigError(
      `${label} is not a GraphQL schema: it stops making sense at line ${err.line}.`,
      {
        hint: "Pass an SDL file (schema.graphql), or the JSON a GraphQL introspection query returned.",
        cause: err,
      },
    );
  }
}

/** Read the schema file `--schema` names. Nothing is requested. */
export async function readGraphqlSchemaFile(path: string): Promise<GqlSchema> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`The schema file ${path} could not be read.`, {
      hint: "Give the path of an SDL file or of the JSON an introspection query returned: --schema ./schema.graphql",
    });
  }
  return schemaFromText(text, path);
}

// ---------------------------------------------------------------------------------------------
// The endpoint, and the one request

/**
 * The introspection query, as small as it can be and still say what the checks need (it never asks
 * for the mutation or subscription root: those are not checked, and not named in a request): the type of
 * each name, its fields (deprecated ones included, so a field the server still answers is never
 * reported), what each returns, and which types an interface or union can be. A constant: nothing
 * from the repository is ever put in it.
 */
export const INTROSPECTION_QUERY =
  "query IntrospectionQuery{__schema{queryType{name}" +
  "types{kind name fields(includeDeprecated:true){name type{...TypeRef}}interfaces{name}possibleTypes{name}}}}" +
  "fragment TypeRef on __Type{kind name ofType{kind name ofType{kind name ofType{kind name ofType{kind name ofType{kind name ofType{kind name ofType{kind name}}}}}}}}";

const SANITY_HOST = /^([a-z0-9]{1,32})\.(?:api|apicdn)\.sanity\.io$/i;

/** Sanity's GraphQL address for a project: https://<projectId>.api.sanity.io/v1/graphql/<dataset>/default. */
export function sanityGraphqlEndpoint(projectId: string, dataset: string, tag = "default"): string {
  return `https://${projectId}.api.sanity.io/v1/graphql/${encodeURIComponent(dataset)}/${encodeURIComponent(tag)}`;
}

/**
 * The endpoint to ask when none was given: Sanity's, built from SANITY_PROJECT_ID and SANITY_DATASET
 * (`production` when unset). Throws ConfigError when there is no project id.
 */
export function defaultGraphqlEndpoint(env: Env): { endpoint: string; datasetAssumed: boolean } {
  let s;
  try {
    s = sanitySettings(env);
  } catch (err) {
    throw new ConfigError(
      `gaugeline query --graphql with no endpoint asks Sanity's GraphQL API for the project, and ${err instanceof Error ? err.message : String(err)}`,
      {
        hint: `Set ${SANITY_PROJECT_ID} (and ${SANITY_DATASET}), or give the endpoint: gaugeline query ./src --graphql https://example.com/graphql. Or give a schema file with --schema.`,
      },
    );
  }
  return {
    endpoint: sanityGraphqlEndpoint(s.projectId, s.dataset),
    datasetAssumed: s.datasetAssumed,
  };
}

/** The project and dataset a Sanity GraphQL address names, or null when the address is not Sanity's. */
export function parseSanityEndpoint(
  endpoint: string,
): { projectId: string; dataset: string } | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  const host = SANITY_HOST.exec(u.hostname);
  if (!host) return null;
  const parts = u.pathname.split("/").filter((p) => p !== "");
  // /v1/graphql/<dataset>/<tag>
  if (parts[1] !== "graphql" || !parts[2]) return null;
  let dataset: string;
  try {
    dataset = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  return { projectId: (host[1] as string).toLowerCase(), dataset };
}

/** True for a host that is Sanity's own. */
export const isSanityHost = (endpoint: string): boolean => {
  try {
    return SANITY_HOST.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

/** The endpoint as it is printed: no user name or password, and a query string shown only as that it exists. */
export function displayEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname}${u.search === "" ? "" : "?\u2026"}`;
  } catch {
    return "the endpoint";
  }
}

/**
 * The token for an endpoint, from the environment and never from the address. Sanity's address
 * gets SANITY_TOKEN, and any other address gets GRAPHQL_TOKEN only: a Sanity token is never sent
 * to a server that is not Sanity's.
 */
export function graphqlToken(
  endpoint: string,
  env: Env,
): { name: string; value: string | undefined } {
  const name = isSanityHost(endpoint) ? SANITY_TOKEN : GRAPHQL_TOKEN;
  const value = (env[name] ?? "").trim();
  return { name, value: value === "" ? undefined : value };
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1"]);

const SCHEMA_HINT =
  "Gaugeline asks for the schema with a GET and never a POST. Write the schema to a file and pass it: gaugeline query ./src --graphql --schema ./schema.graphql (an SDL file, or the JSON an introspection query returned).";

/**
 * Ask an endpoint for its schema: the introspection query, sent as a GET with the query in the
 * address (GraphQL over HTTP), through the fetcher, with the token in an Authorization header when
 * there is one. Returns the schema in the structures the checks use. An endpoint that refuses,
 * will not answer a GET, or has introspection turned off throws a ConfigError that names the
 * `--schema` option; nothing else is sent in its place, and no POST is ever attempted.
 */
export async function introspect(
  endpoint: string,
  token: string | undefined,
  fetcher: Fetcher,
): Promise<GqlSchema> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError(`${endpoint} is not an address.`, {
      hint: "Give the full address of the GraphQL endpoint, for example https://example.com/graphql",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ConfigError(`${displayEndpoint(endpoint)} is not an http or https address.`);
  if (url.username !== "" || url.password !== "")
    throw new ConfigError("The endpoint has a user name or password in the address.", {
      hint: `Put the token in ${GRAPHQL_TOKEN} (or ${SANITY_TOKEN} for Sanity); Gaugeline sends it in a header, never in the address.`,
    });
  const shown = displayEndpoint(endpoint);
  if (token !== undefined && url.protocol !== "https:" && !LOOPBACK.has(url.hostname))
    throw new ConfigError(
      `The endpoint ${shown} is not https, and a token would cross the network in the clear.`,
      {
        hint: "Use the https address, or leave the token out for a public endpoint.",
      },
    );
  url.searchParams.set("query", INTROSPECTION_QUERY);
  const redact = createRedactor(token === undefined ? {} : { T: token }, ["T"]);
  let body: string;
  try {
    const hop = await connectorGet(fetcher, url.href, {
      headers: { accept: "application/json" },
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    });
    if (hop.truncated)
      throw new ConfigError(`The schema ${shown} sent is larger than one request can carry.`, {
        hint: SCHEMA_HINT,
      });
    body = hop.body ?? "";
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err instanceof ConnectorRefusedError)
      throw new ConfigError(`${shown} refused the request (HTTP ${err.status}).`, {
        hint:
          token === undefined
            ? `If the endpoint needs a token, set ${isSanityHost(endpoint) ? SANITY_TOKEN : GRAPHQL_TOKEN} to a read-only one. ${SCHEMA_HINT}`
            : `Check the token has read access. ${SCHEMA_HINT}`,
      });
    if (err instanceof ConnectorRateLimitedError)
      throw new ConfigError(err.message, { hint: "Run it again in a minute." });
    if (err instanceof ConnectorStatusError)
      throw new ConfigError(
        `${shown} would not answer the schema query sent as a GET (HTTP ${err.status}).`,
        {
          hint: SCHEMA_HINT,
        },
      );
    throw new ConfigError(
      redact(err instanceof Error ? err.message : String(err))
        .split(url.href)
        .join(shown),
      { hint: SCHEMA_HINT },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ConfigError(`${shown} answered with something that is not JSON.`, {
      hint: `Check the address is the GraphQL endpoint. ${SCHEMA_HINT}`,
    });
  }
  try {
    return schemaFromIntrospection(json);
  } catch {
    throw new ConfigError(
      `${shown} did not return its schema: introspection is probably turned off.`,
      {
        hint: SCHEMA_HINT,
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The check

export const GRAPHQL_TITLES = {
  notInSchema: "A field your GraphQL query asks for is not in the schema",
} as const;

/** What a type or field leads to: the field's entry on the type, or on any type it can be. */
function returnOf(
  schema: GqlSchema,
  type: string,
  field: string,
): { type: string; list: boolean } | undefined {
  const direct = schema.returns.get(type)?.get(field);
  if (direct) return direct;
  for (const member of schema.possible.get(type) ?? []) {
    const via = schema.returns.get(member)?.get(field);
    if (via) return via;
  }
  return undefined;
}

/** True when `type` has `field`, itself or (for an interface or a union) through a type it can be. */
function hasField(schema: GqlSchema, type: string, field: string): boolean {
  if (schema.fields.get(type)?.has(field)) return true;
  for (const member of schema.possible.get(type) ?? [])
    if (schema.fields.get(member)?.has(field)) return true;
  return false;
}

/** The type a use was asked on: its own condition, else where its chain leads from the query root. Null when the chain breaks. */
function parentOf(use: GqlFieldUse, schema: GqlSchema): string | null {
  let cur = schema.queryType;
  for (const step of use.chain) {
    const at = step.on === "" ? cur : step.on;
    const to = returnOf(schema, at, step.field);
    if (!to) return null;
    cur = to.type;
  }
  return use.parent === "" ? cur : use.parent;
}

/** True when the schema knows the field the use asks for. Uses whose type the schema does not have are not decided. */
function known(use: GqlFieldUse, schema: GqlSchema): boolean | null {
  const parent = parentOf(use, schema);
  if (parent === null || !schema.fields.has(parent)) return null;
  return hasField(schema, parent, use.field);
}

/**
 * The fields the documents ask for that the schema does not have, one finding for each field at
 * each place it is written ("author isn't in the schema", with the path and the file and line). A
 * field on an interface or a union is found through the types it can be. A field below one that
 * is itself missing is not reported again, and a use whose type the schema does not have cannot be
 * decided, so it is left alone. One Map lookup and one Set lookup for each field use.
 */
export function checkGraphql(uses: readonly GqlFieldUse[], schema: GqlSchema): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const use of uses) {
    if (known(use, schema) !== false) continue;
    // A fragment read at two places is one mistake in one file.
    const key = `${use.field}|${use.source.file}:${use.source.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parent = parentOf(use, schema) ?? "";
    const field = escapeInvisible(use.field, 80);
    const file = escapeInvisible(use.source.file, 200);
    out.push({
      checkId: "graphql-field-not-in-schema",
      severity: "high",
      title: `${field} isn't in the schema`,
      evidence: `${escapeInvisible(use.path, 200)} \u00B7 ${file}:${use.source.line}`,
      url: `graphql:${escapeInvisible(parent, 60)}`,
      source: { file: use.source.file, line: use.source.line },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The content counts

/** True for a type Sanity's GraphQL API makes for a document type: it implements the Document interface. */
export const isDocumentType = (schema: GqlSchema, type: string): boolean =>
  schema.implementsOf.get(type)?.has("Document") === true;

/** Sanity names the GraphQL type of a document type with a capital first letter (`blogPost` is `BlogPost`). */
const sanityTypeOf = (graphqlType: string): string =>
  graphqlType.charAt(0).toLowerCase() + graphqlType.slice(1);

/**
 * What each query asks of each document type, as the shapes the content count step reads. A root
 * field that returns a Document type (allResource) gives the shape of that type: its leaf fields
 * as paths, a reference written `author->name` and a list of objects `sections[].heading`, so
 * the count lands on the field itself. A field the schema does not have is left out: it was
 * reported by checkGraphql and counting it would report it twice. The type is the GraphQL type's
 * name with a lower-case first letter, which is how Sanity makes it; every shape leaves drafts out,
 * because the GraphQL API serves published documents.
 */
export function graphqlShapes(uses: readonly GqlFieldUse[], schema: GqlSchema): QueryShape[] {
  const shapes = new Map<
    string,
    { type: string; source: SourceRef; fields: Map<string, FieldUse> }
  >();
  for (const use of uses) {
    if (!use.leaf || known(use, schema) !== true) continue;
    let docType: string | null = null;
    let path = "";
    let cur = schema.queryType;
    let broken = false;
    for (const step of use.chain) {
      const at = step.on === "" ? cur : step.on;
      const to = returnOf(schema, at, step.field);
      if (!to) {
        broken = true;
        break;
      }
      cur = to.type;
      if (docType === null) {
        if (isDocumentType(schema, cur)) docType = cur;
      } else {
        const seg = `${step.field}${to.list ? "[]" : ""}${isDocumentType(schema, cur) ? "->" : ""}`;
        path = path === "" || path.endsWith("->") ? `${path}${seg}` : `${path}.${seg}`;
      }
    }
    if (broken) continue;
    const parent = use.parent === "" ? cur : use.parent;
    if (docType === null) {
      if (!isDocumentType(schema, parent)) continue;
      docType = parent;
    }
    const full =
      path === "" || path.endsWith("->") ? `${path}${use.field}` : `${path}.${use.field}`;
    const key = `${use.root.file}:${use.root.line}|${docType}`;
    const shape = shapes.get(key) ?? {
      type: sanityTypeOf(docType),
      source: use.root,
      fields: new Map<string, FieldUse>(),
    };
    if (!shape.fields.has(full))
      shape.fields.set(full, { path: full, deref: full.includes("->"), source: use.source });
    shapes.set(key, shape);
  }
  return [...shapes.values()].map((s) => ({
    type: s.type,
    fields: [...s.fields.values()],
    excludesDrafts: true,
    params: [],
    source: s.source,
  }));
}
