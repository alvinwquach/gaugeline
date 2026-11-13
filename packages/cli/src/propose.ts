import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  ConfigError,
  checkRedirects,
  createFetcher,
  isRefusal,
  legacyClaims,
  legacyPath,
  parseResult,
  proposalFile,
  readPlan,
  redirectProposal,
  structuredDataProposals,
  type FetcherOptions,
  type Outcome,
  type Proposal,
  type RepoFile,
} from "@gaugeline/core";

export interface ProposeIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface ProposeDeps {
  cwd?: string;
  fetcher?: FetcherOptions;
}

/** Folders that are never part of a project's own files. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".vercel",
  ".netlify",
  ".cache",
]);
/** The files a fixer reads: pages, templates, scripts, data and the two redirect files. */
const READABLE =
  /(^|\/)(_redirects|vercel\.json)$|\.(html?|json|jsonld|[cm]?[jt]sx?|astro|vue|svelte|mdx?|php|liquid|njk|hbs)$/i;
const MAX_FILES = 5000;
const MAX_BYTES = 1_000_000;

/**
 * The project's readable files, by path inside the folder (forward slashes). Reads only: links are not
 * followed, build and dependency folders are skipped, and a file over 1 MB is left out.
 */
export function readProjectFiles(dir: string): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (out.length >= MAX_FILES) return;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const path = relative(dir, full).replace(/\\/g, "/");
        if (!READABLE.test(path) || lstatSync(full).size > MAX_BYTES) continue;
        out.push({ path, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const gone = (what: string): ConfigError =>
  new ConfigError(`${what} could not be read.`, {
    hint: "Check the path: gaugeline propose reads the folder and the files, and changes none of them.",
  });

/**
 * gaugeline propose: findings that live in code become proposals (a diff each), printed and written to
 * a file. Fixes are off until --fixes. Nothing here changes a project, a repository or a site, and
 * nothing is sent anywhere: applying a proposal is a separate, approved step (ADR-0010).
 */
export async function runPropose(
  args: {
    run?: string;
    repo: string;
    plan?: string;
    base?: string;
    repository?: string;
    out: string;
    fixes: boolean;
    allowPrivate: boolean;
    quiet: boolean;
  },
  io: ProposeIo,
  deps: ProposeDeps,
): Promise<Outcome> {
  if (!args.fixes)
    throw new ConfigError("Fix proposals are off by default.", {
      hint: "Add --fixes (or set GAUGELINE_FIXES=1) to turn them on. They only read, print and write a file.",
    });
  const cwd = deps.cwd ?? process.cwd();
  const root = resolve(cwd, args.repo);
  let files: RepoFile[];
  try {
    files = readProjectFiles(root);
  } catch {
    throw gone(args.repo);
  }
  const repository = args.repository ?? null;
  const proposals = new Map<string, Proposal>();
  const notes: string[] = [];
  const add = (found: Proposal | { refused: string }, what: string): void => {
    if (isRefusal(found)) notes.push(`No proposal for ${what}: ${found.refused}`);
    else proposals.set(found.id, found);
  };

  if (args.plan !== undefined && args.base !== undefined) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(cwd, args.plan));
    } catch {
      throw gone(args.plan);
    }
    const plan = readPlan(bytes, { fileName: basename(args.plan) });
    const fetcher = createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate ? { allowPrivate: true } : {}),
    });
    const result = await checkRedirects(plan.rows, {
      base: args.base,
      fetcher,
      file: basename(args.plan),
    });
    const claims = legacyClaims(plan.rows);
    for (const f of result.findings) {
      if (f.checkId !== "plan-redirect-missing") continue;
      const claim = f.group ? claims.get(f.group.key) : undefined;
      const old = claim ? legacyPath(claim.legacy) : undefined;
      const row = claim?.rows[0];
      if (!claim || !old || !row) continue;
      const what = `${f.checkId} (${old.path})`;
      if (claim.rows.length !== 1)
        add({ refused: "more than one plan row claims this address." }, what);
      else if (old.search !== "")
        add(
          {
            refused:
              "the old address has a query string, which a redirect file does not match the same way.",
          },
          what,
        );
      else
        add(
          redirectProposal(
            files,
            { checkId: f.checkId, url: f.url, evidence: f.evidence },
            { from: old.path, to: row.path },
            repository,
          ),
          what,
        );
    }
  }

  if (args.run !== undefined) {
    let saved;
    try {
      saved = parseResult(JSON.parse(readFileSync(resolve(cwd, args.run), "utf8")));
    } catch {
      throw new ConfigError(`${args.run} is not a saved Gaugeline run (--json output).`, {
        hint: "Save a run with gaugeline <address> --json > run.json.",
      });
    }
    for (const f of saved.findings) {
      if (f.checkId !== "facts-match") continue;
      const found = structuredDataProposals(
        files,
        { checkId: f.checkId, url: f.url, evidence: f.evidence },
        { repository },
      );
      if (found.length === 0)
        notes.push(
          `No proposal for ${f.checkId} (${f.url}): the evidence names no structured-data value.`,
        );
      for (const p of found) add(p, `${f.checkId} (${f.url})`);
    }
  }

  const list = [...proposals.values()];
  for (const p of list) {
    io.stdout.write(`${p.id}  ${p.fixer}  ${p.summary}\n`);
    io.stdout.write(`  answers ${p.finding.checkId}: ${p.finding.evidence}\n`);
    io.stdout.write(`  checked again by: ${p.recheck.how}\n\n${p.change.diff}\n`);
  }
  if (!args.quiet) for (const n of notes) io.stderr.write(`${n}\n`);
  if (list.length > 0) {
    writeFileSync(resolve(cwd, args.out), `${JSON.stringify(proposalFile(list), null, 2)}\n`, {
      flag: "w",
    });
    io.stdout.write(
      `${list.length} proposal${list.length === 1 ? "" : "s"} written to ${args.out}. Nothing was sent anywhere.\n`,
    );
  } else {
    io.stdout.write("No proposals: nothing was written and nothing was sent.\n");
  }
  return { kind: "ran", highFindings: 0, drift: false };
}
