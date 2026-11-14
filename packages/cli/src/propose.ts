import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  checkRedirects,
  createFetcher,
  isRefusal,
  isSafeDiffPath,
  legacyClaims,
  legacyPath,
  parseResult,
  performanceProposals,
  proposalFile,
  readPlan,
  redirectProposal,
  structuredDataProposals,
  toInboxDraft,
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

/** A file left out of the read, and why: shown to the person, never a crash. */
export type Left = { path: string; why: string };

type Read = { text: string } | { left?: string };

/** The path an open handle really is at, on a system that says (Linux's /proc), or undefined. */
function pathOfHandle(fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

const inside = (root: string, real: string): boolean =>
  real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * One file, opened and read the careful way: without following a link at the file (O_NOFOLLOW), never waiting on
 * a pipe (O_NONBLOCK), checked (a regular file, at most 1 MB) and read on the same open handle, never past 1 MB
 * plus one byte. With `root` (the project folder's real path) the opened file must also really be inside it: a
 * folder swapped for a link to somewhere else while the folder is read would otherwise lead the open outside. On
 * Linux the handle's own path is asked for (it cannot be raced); elsewhere the path is resolved after the open and
 * must be the very file that was opened (same device and inode). An error of any kind (it vanished, it is not a
 * folder any more, no access) leaves the file out with the reason.
 */
function readChecked(
  full: string,
  buffer: Buffer | undefined,
  root: string | undefined,
  proc: boolean,
): Read {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  // Where the system has no O_NOFOLLOW (Windows) a link is refused by a check made first.
  if (noFollow === 0) {
    try {
      if (!lstatSync(full).isFile()) return {};
    } catch (e) {
      return { left: `could not be read (${(e as { code?: string }).code ?? "error"})` };
    }
  }
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as { code?: string }).code ?? "error";
    // A link (ELOOP) is left out on purpose; anything else that went wrong is worth saying.
    return code === "ELOOP" ? {} : { left: `could not be opened (${code})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return {};
    if (root !== undefined) {
      let real = proc ? pathOfHandle(fd) : undefined;
      if (real === undefined) {
        real = realpathSync(full);
        const again = statSync(real);
        if (again.ino !== stat.ino || again.dev !== stat.dev)
          return { left: "changed while it was read" };
      }
      if (!inside(root, real)) return { left: "is not inside the project folder any more" };
    }
    const buf = buffer ?? Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    while (n < MAX_BYTES + 1) {
      const got = readSync(fd, buf, n, MAX_BYTES + 1 - n, null);
      if (got === 0) break;
      n += got;
    }
    return n > MAX_BYTES ? {} : { text: buf.toString("utf8", 0, n) };
  } catch (e) {
    return { left: `could not be read (${(e as { code?: string }).code ?? "error"})` };
  } finally {
    closeSync(fd);
  }
}

/** The text of one regular file of at most 1 MB, or undefined (see readChecked). */
export function readRegularFile(
  full: string,
  buffer?: Buffer,
  root?: string,
  options: { proc?: boolean } = {},
): string | undefined {
  const read = readChecked(full, buffer, root, options.proc ?? true);
  return "text" in read ? read.text : undefined;
}

/**
 * The project's readable files, by path inside the folder (forward slashes). Reads only: links are not
 * followed (a file is opened with O_NOFOLLOW and read from the handle it was checked on, and has to be inside the
 * project's real path), build and dependency folders are skipped, a file over 1 MB is left out, and so is a name
 * that cannot be written in a diff header. A folder or file that cannot be read (it vanished, was swapped, no
 * access) is left out and listed in `left` with the reason; only the project folder itself can throw.
 */
export function readProjectFiles(dir: string, left: Left[] = []): RepoFile[] {
  const out: RepoFile[] = [];
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  const root = realpathSync(dir);
  const walk = (folder: string, top: boolean): void => {
    let entries;
    try {
      // A folder is checked not to be a link at the moment it is opened, then listed.
      if (!top && constants.O_DIRECTORY !== undefined && constants.O_NOFOLLOW !== undefined)
        closeSync(
          openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
        );
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (e) {
      if (top) throw e;
      const code = (e as { code?: string }).code ?? "error";
      if (code !== "ELOOP")
        left.push({
          path: relative(dir, folder).replace(/\\/g, "/"),
          why: `could not be listed (${code})`,
        });
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= MAX_FILES) return;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full, false);
      } else if (entry.isFile()) {
        const path = relative(dir, full).replace(/\\/g, "/");
        // A name that cannot be written in a diff header (a newline, a leading -) is left out, not quoted.
        if (!isSafeDiffPath(path) || !READABLE.test(path)) continue;
        const read = readChecked(full, buffer, root, true);
        if ("text" in read) out.push({ path, text: read.text });
        else if (read.left !== undefined) left.push({ path, why: read.left });
      }
    }
  };
  walk(dir, true);
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
    toInbox?: string;
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
  const left: Left[] = [];
  try {
    files = readProjectFiles(root, left);
  } catch {
    throw gone(args.repo);
  }
  const repository = args.repository ?? null;
  const proposals = new Map<string, Proposal>();
  const notes: string[] = left.map((l) => `Left out of the read: ${l.path || "."} ${l.why}.`);
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
      if (f.checkId.startsWith("perf-")) {
        // The speed causes (PERF-04): a diff where the change is certain, the reason where it is left to a person.
        for (const p of performanceProposals(
          files,
          { checkId: f.checkId, url: f.url, evidence: f.evidence },
          { repository },
        ))
          add(p, `${f.checkId} (${f.url})`);
        continue;
      }
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
  if (args.toInbox !== undefined && list.length > 0) {
    // The inbox's draft carries the whole new text of each file, so each diff is applied to the file as it is.
    const drafts = [];
    for (const p of list) {
      const text = files.find((f) => f.path === p.target.path)?.text ?? "";
      const draft = toInboxDraft(p, text);
      if (isRefusal(draft)) io.stderr.write(`No inbox draft for ${p.id}: ${draft.refused}\n`);
      else drafts.push(draft);
    }
    writeFileSync(
      resolve(cwd, args.toInbox),
      `${JSON.stringify({ version: 1, drafts }, null, 2)}\n`,
      { flag: "w" },
    );
    io.stdout.write(
      `${drafts.length} inbox draft${drafts.length === 1 ? "" : "s"} written to ${args.toInbox}. Nothing was sent: a person approves a draft in the inbox first.\n`,
    );
  }
  return { kind: "ran", highFindings: 0, drift: false };
}
