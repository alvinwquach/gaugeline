import {
  SANITY_DESCRIPTION,
  adapterHeader,
  resolveAdapters,
  checkMutationsOnly,
  compareQueries,
  ConfigError,
  createFetcher,
  extractGroq,
  freezeEnv,
  readMutations,
  queryFieldAbsent,
  queryFieldPartial,
  queryNoDraftsFilter,
  queryTypeEmpty,
  readSchemaFile,
  serializeBaseline,
  toBaseline,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  type FetcherOptions,
  type MutationShape,
  type MutationUnreadable,
  type Outcome,
  type QueryBaseline,
  type QueryShape,
  type Unreadable,
} from "@gaugeline/core";
import { resolve } from "node:path";
import { compare, readBaselineFile, withCwdFiles } from "./query-baseline.js";
import { runGenerated } from "./query-generated.js";
import { runGraphql } from "./query-graphql.js";
import { runPage } from "./query-page.js";
import { schemaPath } from "./query-schema.js";
import { inspectBaselineFile, writeBaselineFile, type ScaffoldFs } from "./scaffold-write.js";
import { runSuggest } from "./query-suggest.js";
import { runUnused } from "./query-unused.js";
import { formatTerminal } from "./reporter.js";
import { readAdaptersConfig } from "./schema-config.js";

/** Why each kind of unreadable query was left alone, in a sentence a person can act on. */
const WHY: Record<Unreadable["reason"], string> = {
  concatenated:
    "built at run time (a template with an interpolation, strings joined with +, or a variable), so it cannot be read from the file",
  "parse-error":
    "could not be parsed: the file has a syntax error, or the string is not valid GROQ",
  "no-type-filter": "no _type filter, so there is no document type to attribute it to",
  "unknown-fragment": "spreads a fragment that no file that was read defines",
};

/** Why each write that could not be read was left alone. */
const WHY_WRITE: Record<MutationUnreadable["reason"], string> = {
  "variable-key":
    "a field name comes from a variable or an expression, so the field cannot be read from the file",
  "variable-payload":
    "the payload is a variable or a call the file does not settle, so its fields cannot be read",
  "parse-error": "the file has a syntax error, so none of its writes were read",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A source file as the person would type it from where they ran the command: the folder they gave, then the path in it. */
function shown(prefix: string, file: string): string {
  return prefix === "" ? file : `${prefix}/${file}`;
}

function shapeLines(q: QueryShape): string[] {
  return [
    `${q.type}  ${q.source.file}:${q.source.line}`,
    `  fields: ${q.fields.length === 0 ? "none" : q.fields.map((f) => f.path).join(", ")}`,
    `  drafts: ${q.excludesDrafts ? "left out by the filter" : "not left out by the filter"}`,
    `  params: ${q.params.length === 0 ? "none" : q.params.map((p) => `$${p}`).join(", ")}`,
  ];
}

/** "3 patches, 1 create and 1 transaction", for the line that says what was read. */
function mutationCounts(shapes: readonly MutationShape[]): string {
  const by = new Map<string, number>();
  for (const s of shapes) by.set(s.kind, (by.get(s.kind) ?? 0) + 1);
  const parts = [...by].map(([k, n]) => plural(n, k, k === "patch" ? "patches" : `${k}s`));
  return parts.length <= 1
    ? (parts[0] ?? "nothing")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What was read from the writes in the code, and what was left. Says every time that nothing was sent. */
function mutationLines(
  writes: readonly MutationShape[],
  unread: readonly MutationUnreadable[],
  dir: string,
): string[] {
  const lines: string[] = [];
  if (writes.length === 0)
    lines.push(
      `No writes found under ${dir}. It looks for patch, create, createOrReplace, createIfNotExists, delete and transaction calls on a client named like client or sanity, and for raw mutations arrays. Nothing was sent.`,
    );
  else {
    const files = new Set(writes.map((w) => w.source.file)).size;
    lines.push(
      `Read ${plural(writes.length, "write")} in ${plural(files, "file")} (${mutationCounts(writes)}) and checked them against the schema. They were parsed, not run: nothing was sent.`,
    );
  }
  const partial = writes.filter((w) => w.partial);
  if (partial.length > 0)
    lines.push(
      "",
      `Checked on the fields that are visible (a spread or a variable hides the rest):`,
      ...partial.map((w) => `  ${w.source.file}:${w.source.line}`),
    );
  if (unread.length > 0) {
    lines.push("", `Could not read ${plural(unread.length, "write")}:`);
    for (const u of unread)
      lines.push(`  ${u.source.file}:${u.source.line}  ${u.reason}: ${WHY_WRITE[u.reason]}`);
  }
  return lines;
}

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
  /** Tests: the file system the baseline is written with. */
  fs?: ScaffoldFs;
}

/**
 * gaugeline query <folder>: the GROQ in a repository, as shapes. One block for each shape (the
 * document type, the fields it reads, whether the filter leaves drafts out, the parameters, and
 * the file and line the query starts on), then the queries that could not be read and why, then the
 * findings. With SANITY_PROJECT_ID set the dataset is asked for counts, one GET for each type;
 * without it nothing is requested, nothing is compared, and a line on stderr says so. With --dupes
 * (which needs SANITY_PROJECT_ID) it also asks, one more GET for each type, for the id, slug and
 * title of each published document, and reports documents that share a slug or a title.
 * Files are shown as they would be typed from where the command ran, in the findings too.
 * With --mutations (it needs no SANITY_PROJECT_ID) it also reads the writes in the code, patches,
 * creates and transactions, and checks their shapes against the schema file (--schema, default
 * ./schema.json). The mutations are parsed and never sent: this command builds no request for one.
 * With --save <file> (after the run) the gaps it found are written to a baseline file of names only,
 * through the safe writer in scaffold-write.ts; with --against <file> the run prints only what a
 * change created and closed since that file was saved (a Set of keys, see core's baseline.ts), and
 * with --ci exits 1 only for a created gap that is high. Both need SANITY_PROJECT_ID or --mutations.
 * Exit 0, 1 with --ci and a fix-first finding, or 2 (a ConfigError) when the folder does not
 * exist, TypeScript is missing or the dataset cannot be read.
 */
export async function runQuery(
  args: {
    dir: string;
    json?: boolean;
    dupes?: boolean;
    mutations?: boolean;
    graphql?: { endpoint?: string };
    suggest?: { type: string };
    page?: { type: string; out: string; force: boolean };
    unused?: boolean;
    generated?: { totals: readonly string[]; refs: readonly string[] };
    save?: { file: string; force: boolean };
    against?: { file: string };
    schema?: string;
    allowPrivate?: boolean;
    quiet?: boolean;
  },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  if (args.page !== undefined)
    return runPage(
      {
        page: args.page,
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        ...(args.allowPrivate === undefined ? {} : { allowPrivate: args.allowPrivate }),
        ...(args.quiet === undefined ? {} : { quiet: args.quiet }),
      },
      io,
      { cwd: deps.cwd, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) },
    );
  if (args.generated !== undefined)
    return runGenerated(
      {
        dir: args.dir,
        generated: args.generated,
        ...(args.json === undefined ? {} : { json: args.json }),
        ...(args.allowPrivate === undefined ? {} : { allowPrivate: args.allowPrivate }),
        ...(args.quiet === undefined ? {} : { quiet: args.quiet }),
      },
      io,
      deps,
    );
  if (args.unused === true)
    return runUnused(
      { dir: args.dir, ...(args.json === undefined ? {} : { json: args.json }) },
      io,
      {
        cwd: deps.cwd,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.color === undefined ? {} : { color: deps.color }),
      },
    );
  if (args.suggest !== undefined)
    return runSuggest(
      {
        dir: args.dir,
        suggest: args.suggest,
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        ...(args.allowPrivate === undefined ? {} : { allowPrivate: args.allowPrivate }),
        ...(args.quiet === undefined ? {} : { quiet: args.quiet }),
      },
      io,
      { cwd: deps.cwd, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) },
    );
  if (args.graphql !== undefined)
    return runGraphql(
      {
        dir: args.dir,
        graphql: args.graphql,
        ...(args.json === undefined ? {} : { json: args.json }),
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        ...(args.allowPrivate === undefined ? {} : { allowPrivate: args.allowPrivate }),
        ...(args.quiet === undefined ? {} : { quiet: args.quiet }),
      },
      io,
      deps,
    );
  const asks = (io.env?.[SANITY_PROJECT_ID] ?? "").trim() !== "";
  // gaugeline.adapters.json, when there is one, must name adapters that exist: checked before anything is asked.
  if (asks) {
    const named = readAdaptersConfig(deps.cwd);
    if (named) resolveAdapters(named);
  }
  if (args.json && !asks && args.mutations !== true)
    throw new ConfigError(
      "gaugeline query --json prints findings, and they need SANITY_PROJECT_ID or --mutations.",
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset), or add --mutations, or leave --json out to list the queries.",
      },
    );
  if (args.dupes && !asks)
    throw new ConfigError(
      "gaugeline query --dupes asks your dataset for each document's id, slug and title, and that needs SANITY_PROJECT_ID.",
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset), or leave --dupes out to list the queries.",
      },
    );
  const baselineFlag =
    args.save !== undefined ? "--save" : args.against !== undefined ? "--against" : "";
  if (baselineFlag !== "" && !asks && args.mutations !== true)
    throw new ConfigError(
      `gaugeline query ${baselineFlag} keeps the gaps your queries have against your content, and they need SANITY_PROJECT_ID or --mutations.`,
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset), or add --mutations to keep the gaps in your writes.",
      },
    );
  // The baseline is read, or its target checked, before anything is asked or read.
  const before: QueryBaseline | undefined = args.against
    ? await readBaselineFile(deps.cwd, args.against.file)
    : undefined;
  if (args.save)
    await inspectBaselineFile(args.save.file, {
      force: args.save.force,
      cwd: deps.cwd,
      ...(deps.fs ? { fs: deps.fs } : {}),
    });
  // The schema is read first: a missing file stops the command before anything else is done.
  const schema =
    args.mutations === true
      ? await readSchemaFile(await schemaPath(deps.cwd, args.dir, args.schema))
      : undefined;
  const found = await extractGroq(resolve(deps.cwd, args.dir));
  // Windows separators and a trailing slash go; "." prints as nothing, so lines read like paths from here.
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = typed === "." ? "" : typed;
  const at = <T extends { source: { file: string; line: number } }>(x: T): T => ({
    ...x,
    source: { file: shown(prefix, x.source.file), line: x.source.line },
  });
  const queries = found.queries.map(at);
  const unreadable = found.unreadable.map(at);
  const sites = new Set(queries.map((q) => `${q.source.file}:${q.source.line}`));
  const total = sites.size + unreadable.length;
  const written = schema ? await readMutations(resolve(deps.cwd, args.dir)) : undefined;
  const prefixed = (m: MutationShape): MutationShape => ({
    ...m,
    source: { file: shown(prefix, m.source.file), line: m.source.line },
    ...(m.ops ? { ops: m.ops.map(prefixed) } : {}),
  });
  const writes = written?.shapes.map(prefixed) ?? [];
  const writesUnread = written?.unreadable.map(at) ?? [];
  const mutations = schema ? { shapes: writes, schema } : undefined;

  // Without a project id nothing is asked and nothing is compared: the output is the shapes alone.
  const now = deps.now ?? new Date();
  const run =
    total > 0 && asks
      ? await compareQueries({
          shapes: queries,
          env: freezeEnv(io.env ?? {}, [SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN]),
          fetcher: createFetcher({
            ...deps.fetcher,
            ...(args.allowPrivate === true ? { allowPrivate: true } : {}),
          }),
          now,
          dupes: args.dupes === true,
          ...(mutations ? { mutations } : {}),
        })
      : mutations
        ? // No request: this path never builds a fetcher.
          await checkMutationsOnly({ mutations, now })
        : undefined;
  if (args.quiet !== true) {
    if (run) for (const n of run.notices) io.stderr.write(`${n}\n`);
    else if (total > 0 && !asks)
      io.stderr.write(
        "SANITY_PROJECT_ID is not set, so the queries were not compared with your content. Set it (and SANITY_TOKEN, with the Viewer role, for a private dataset) to count the documents.\n",
      );
  }
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run ? run.result.findings.filter((f) => f.severity === "high").length : 0,
    drift: false,
  };
  if (args.json && run) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }
  const kept = withCwdFiles(deps.cwd, run?.result.findings ?? []);
  if (before !== undefined && args.against) {
    // The checks this run made: one that found nothing is in `passed`, one that found something has a finding.
    const ran = new Set([
      ...(run?.result.passed ?? []),
      ...kept.map((f) => f.checkId),
      ...(run?.result.couldNotCheck.map((c) => c.id) ?? []),
      // No query found at all: the query checks ran and found nothing, so what was saved is closed.
      ...(run === undefined && asks
        ? [queryFieldAbsent, queryTypeEmpty, queryFieldPartial, queryNoDraftsFilter].map(
            (c) => c.id,
          )
        : []),
    ]);
    const compared = compare({ name: args.against.file, before, findings: kept, ran });
    io.stdout.write(`${compared.lines.join("\n")}\n`);
    return { kind: "ran", highFindings: compared.createdHigh, drift: false };
  }
  let saved: string | undefined;
  if (args.save) {
    if (total === 0 && !mutations)
      throw new ConfigError(
        `No GROQ queries were found under ${args.dir}, so there is nothing to save as a baseline.`,
        {
          hint: "Check the folder: it reads groq`...` templates and defineQuery(...) calls in .ts, .tsx, .js, .jsx and .mjs files.",
        },
      );
    const baseline = toBaseline(kept, now);
    await writeBaselineFile(args.save.file, serializeBaseline(baseline), {
      force: args.save.force,
      cwd: deps.cwd,
      ...(deps.fs ? { fs: deps.fs } : {}),
    });
    saved = `Saved the baseline to ${args.save.file}: ${plural(baseline.gaps.length, "gap")}. It holds check ids, type names, field names and file paths, and no token and no content. Make the change, then run: gaugeline query ${args.dir} --against ${args.save.file}`;
  }

  const out: string[] = [];
  if (total === 0 && !mutations) {
    out.push(
      `No GROQ queries found under ${args.dir}.`,
      "It looks for groq`...` templates and defineQuery(...) calls in .ts, .tsx, .js, .jsx and .mjs files, and skips node_modules, .next, dist and what .gitignore names.",
    );
  } else {
    if (total > 0) {
      for (const q of queries) out.push(...shapeLines(q), "");
      if (unreadable.length > 0) {
        out.push(`Could not read ${plural(unreadable.length, "query", "queries")}:`);
        for (const u of unreadable)
          out.push(`  ${u.source.file}:${u.source.line}  ${u.reason}: ${WHY[u.reason]}`);
        out.push("");
      }
      out.push(
        `${plural(queries.length, "shape")} from ${plural(sites.size, "query", "queries")}` +
          (unreadable.length > 0 ? `; ${unreadable.length} could not be read.` : "."),
      );
    }
    if (run) {
      const { result, counts, dupes } = run;
      if (out.length > 0) out.push("");
      // Which content system was read and with what kind of key, before what was asked of it.
      if (asks) out.push(adapterHeader(SANITY_DESCRIPTION), "");
      if (counts && counts.size > 0)
        out.push(
          `Counted the published documents of ${plural(counts.size, "type")} in the dataset: one request each, counts only.`,
          "",
        );
      if (dupes)
        out.push(
          `Read the ids, slugs and titles of the published documents of ${plural(counts.size, "type")} to look for duplicates: one request each. A title or slug is shown only when two documents share it.`,
          "",
        );
      if (mutations) out.push(...mutationLines(writes, writesUnread, args.dir), "");
      out.push(
        formatTerminal({
          result: {
            findings: result.findings,
            passed: result.passed,
            failed: [],
            warnings: [],
            couldNotCheck: result.couldNotCheck,
            sampled: {},
          },
          color: deps.color ?? false,
        }).trimEnd(),
      );
    }
  }
  if (saved !== undefined) out.push("", saved);
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}
