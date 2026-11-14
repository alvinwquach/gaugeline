/**
 * Fixer 1 (X70): add a missing redirect to the project's redirect file. Two formats are read: Netlify's
 * `_redirects` (one rule a line) and Vercel's `vercel.json` (a `redirects` list). Both are edited as text,
 * in the file's own layout, so the diff is one added rule and nothing else; neither is parsed and written
 * back whole. The fixer makes a proposal only when it is certain: one config file, a file it reads
 * exactly, an old address no rule or pattern already covers, and an address it can write without
 * escaping. Anything else is a refusal that says why, and a person decides.
 */
import {
  buildProposal,
  isRefusal,
  type FileChange,
  type Proposal,
  type Refusal,
} from "./proposal.js";

/** A file of the project: its path inside the repository (forward slashes) and its text. */
export interface RepoFile {
  path: string;
  text: string;
}

export interface RedirectRequest {
  /** The old address's path, as the plan wrote it ("/old-poetry"). */
  from: string;
  /** The page it should land on ("/poetry"). */
  to: string;
}

const refuse = (refused: string): Refusal => ({ refused });

/** Folders a redirect file is never taken from: dependencies, build output, version control. */
const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.vercel|\.netlify)\//;

/** Plain addresses only: a path of plain characters, or an https address, with no space or control. */
const PLAIN = /^[A-Za-z0-9\-._~!$&'()+,;=:@%/]+$/;

function checkRequest(r: RedirectRequest): Refusal | undefined {
  if (!r.from.startsWith("/") || !PLAIN.test(r.from))
    return refuse(
      `The old address "${r.from}" is not a plain path: it needs a person to write the rule.`,
    );
  if (/[*:?#]/.test(r.from))
    return refuse(
      `The old address "${r.from}" has a wildcard, a placeholder or a query: it needs a person to write the rule.`,
    );
  if (
    !(r.to.startsWith("/") || r.to.startsWith("https://")) ||
    !PLAIN.test(r.to) ||
    r.to.includes("*")
  )
    return refuse(`The new address "${r.to}" is not a plain path or https address.`);
  if (r.from.replace(/\/+$/, "") === r.to.replace(/\/+$/, ""))
    return refuse("The old and new addresses are the same: a redirect would loop.");
  return undefined;
}

const normPath = (p: string): string => {
  const x = p.toLowerCase().replace(/\/+$/, "");
  return x === "" ? "/" : x;
};

/** A rule's path with its host dropped ("https://a.example/x" is "/x"), or the text as written. */
function rulePath(source: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(source);
  return m ? (m[1] ?? "/") : source;
}

/** What an existing rule's address does to `path`: it is the same address, a pattern that may match it, or nothing. */
function coverage(source: string, path: string): "same" | "pattern" | "none" {
  const s = rulePath(source);
  if (normPath(s) === normPath(path)) return "same";
  if (!/[*:(){}[\]|?+\\]/.test(s)) return "none";
  // A wildcard, a placeholder or a regular expression: matched where it can be, else treated as a match
  // (not certain, so no proposal).
  try {
    const re = new RegExp(
      `^${s
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/:[A-Za-z_]\w*/g, "[^/]+")}/?$`,
      "i",
    );
    return re.test(path) ? "pattern" : /[(){}[\]|\\]/.test(s) ? "pattern" : "none";
  } catch {
    return "pattern";
  }
}

// --- Netlify: _redirects -------------------------------------------------------------------------

interface NetlifyRule {
  from: string;
  /** The text between the first two columns, and the column the second starts at. */
  gap: string;
  toColumn: number;
  /** The text between the second and third column when there is a third, and where it starts. */
  gap2?: string;
  statusColumn?: number;
}

/** Every rule of a `_redirects` text, or undefined when a line cannot be read exactly. */
function readNetlify(text: string): NetlifyRule[] | undefined {
  const rules: NetlifyRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = /^(\s*)(\S+)(\s+)(\S+)(?:(\s+)(\S+))?/.exec(line);
    if (!m) return undefined;
    const lead = m[1] ?? "";
    const from = m[2] ?? "";
    const gap = m[3] ?? "";
    const to = m[4] ?? "";
    const rule: NetlifyRule = { from, gap, toColumn: lead.length + from.length + gap.length };
    if (m[5] !== undefined) {
      rule.gap2 = m[5];
      rule.statusColumn = rule.toColumn + to.length + m[5].length;
    }
    rules.push(rule);
  }
  return rules;
}

/** The text of one new rule in the layout the file already uses: tabs, a space, or aligned columns. */
function netlifyLine(rules: readonly NetlifyRule[], r: RedirectRequest): string {
  const last = rules.at(-1);
  const status = "301";
  if (!last) return `${r.from} ${r.to} ${status}`;
  // Aligned: the second column starts at the same place on every line although the first column's
  // words differ in length, and it is spaces that line them up (tabs line themselves up).
  const aligned =
    rules.length >= 2 &&
    rules.every((x) => x.toColumn === last.toColumn && !x.gap.includes("\t")) &&
    new Set(rules.map((x) => x.from.length)).size >= 2;
  let gap = last.gap;
  if (aligned && last.toColumn > r.from.length) gap = " ".repeat(last.toColumn - r.from.length);
  else if (aligned) gap = " ";
  const withStatus = rules.filter((x) => x.statusColumn !== undefined);
  const toWidth = (x: NetlifyRule) => (x.statusColumn ?? 0) - x.toColumn - (x.gap2?.length ?? 0);
  const statusAligned =
    withStatus.length >= 2 &&
    withStatus.every(
      (x) => x.statusColumn === withStatus[0]?.statusColumn && !(x.gap2 ?? "").includes("\t"),
    ) &&
    new Set(withStatus.map(toWidth)).size >= 2;
  let gap2 = last.gap2 ?? gap;
  const column = withStatus[0]?.statusColumn;
  if (statusAligned && column !== undefined) {
    const used = (aligned ? last.toColumn : r.from.length + gap.length) + r.to.length;
    gap2 = column > used ? " ".repeat(column - used) : " ";
  }
  return `${r.from}${gap}${r.to}${gap2}${status}`;
}

function fixNetlify(file: RepoFile, r: RedirectRequest): FileChange | Refusal {
  const rules = readNetlify(file.text);
  if (!rules)
    return refuse(
      `${file.path}: a line could not read as "from to [status]", so the file is left to a person.`,
    );
  for (const rule of rules) {
    const c = coverage(rule.from, r.from);
    if (c === "same")
      return refuse(`${file.path} already has a rule for ${r.from} (${rule.from}).`);
    if (c === "pattern")
      return refuse(
        `${file.path} has a pattern, ${rule.from}, that may take ${r.from} before a new rule would.`,
      );
  }
  const eol = file.text.includes("\r\n") ? "\r\n" : "\n";
  // Insert after the last line that has text on it, before any blank lines at the end.
  let end = 0;
  for (const m of file.text.matchAll(/[^\r\n]*[^\s][^\r\n]*/g)) end = (m.index ?? 0) + m[0].length;
  const line = netlifyLine(rules, r);
  const after =
    file.text.trim() === ""
      ? `${line}${eol}`
      : `${file.text.slice(0, end)}${eol}${line}${file.text.slice(end)}`;
  return { path: file.path, before: file.text, after };
}

// --- Vercel: vercel.json ------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/** Where the whitespace after `i` stops. */
function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

/** The end of the JSON string starting at `i` (the index after its closing quote). */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

/** The end of the JSON value starting at `i`, or -1. */
function valueEnd(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return stringEnd(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const d = text[j];
      if (d === '"') {
        j = stringEnd(text, j) - 1;
        if (j < 0) return -1;
      } else if (d === "{" || d === "[") depth++;
      else if ((d === "}" || d === "]") && --depth === 0) return j + 1;
    }
    return -1;
  }
  const m = /^[^\s,\]}]+/.exec(text.slice(i));
  return m ? i + m[0].length : -1;
}

/** The members of the object at `open`: each key with where its value is, and where the object closes. */
function members(
  text: string,
  open: number,
): { items: { key: string; value: Span }[]; close: number } | undefined {
  const items: { key: string; value: Span }[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== "}") {
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return undefined;
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return undefined;
    const start = skipSpace(text, i + 1);
    const end = valueEnd(text, start);
    if (end < 0) return undefined;
    items.push({ key, value: { start, end } });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
    else if (text[i] !== "}") return undefined;
  }
  return { items, close: i };
}

/** The elements of the array at `open`, and where it closes. */
function elements(text: string, open: number): { items: Span[]; close: number } | undefined {
  const items: Span[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== "]") {
    const end = valueEnd(text, i);
    if (end < 0) return undefined;
    items.push({ start: i, end });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
    else if (text[i] !== "]") return undefined;
  }
  return { items, close: i };
}

/** The whitespace at the start of the line that `index` is on, when only whitespace precedes it there. */
function lineIndent(text: string, index: number): string | undefined {
  const from = text.lastIndexOf("\n", index - 1) + 1;
  const lead = text.slice(from, index);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

function fixVercel(file: RepoFile, r: RedirectRequest): FileChange | Refusal {
  const text = file.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(
      `${file.path} is not valid JSON (a comment or a trailing comma?), so it is left to a person.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return refuse(`${file.path} is not an object.`);
  const list = (parsed as { redirects?: unknown }).redirects;
  if (list !== undefined && !Array.isArray(list))
    return refuse(`${file.path}: "redirects" is not a list.`);
  for (const entry of list ?? []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return refuse(`${file.path}: a redirect is not an object.`);
    const source = (entry as { source?: unknown }).source;
    if (typeof source !== "string")
      return refuse(`${file.path}: a redirect has no source address.`);
    const c = coverage(source, r.from);
    if (c === "same") return refuse(`${file.path} already has a rule for ${r.from} (${source}).`);
    if (c === "pattern")
      return refuse(
        `${file.path} has a pattern, ${source}, that may take ${r.from} before a new rule would.`,
      );
  }
  const root = text.indexOf("{");
  const top = members(text, root);
  if (!top) return refuse(`${file.path} could not be read exactly.`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const first = top.items[0];
  // The indentation of the first member, which is one level in; a unit of it is one more level.
  const memberIndent = first ? lineIndent(text, skipSpace(text, root + 1)) : undefined;
  const unit = memberIndent ? memberIndent : "  ";
  const entry = { source: r.from, destination: r.to, statusCode: 301 };
  const found = top.items.find((m) => m.key === "redirects");

  let after: string;
  if (!found) {
    // No "redirects" yet: a new member after the last one, one entry long.
    if (first && memberIndent === undefined)
      return refuse(
        `${file.path} is written on one line, so where a new setting goes is left to a person.`,
      );
    const base = first ? (memberIndent ?? "") : unit;
    const lastEnd = top.items.at(-1)?.value.end ?? root + 1;
    const inner = `${base}"redirects": [${eol}${base}${unit}${oneLine(entry)}${eol}${base}]`;
    after = first
      ? `${text.slice(0, lastEnd)},${eol}${inner}${text.slice(lastEnd)}`
      : `${text.slice(0, root)}{${eol}${inner}${eol}}${text.slice(top.close + 1)}`;
  } else {
    const arrayAt = found.value.start;
    const list2 = elements(text, arrayAt);
    if (!list2) return refuse(`${file.path}: the redirects list could not be read exactly.`);
    const keyIndent = lineIndent(text, text.lastIndexOf('"redirects"', arrayAt));
    const last = list2.items.at(-1);
    if (!last) {
      if (keyIndent === undefined)
        return refuse(
          `${file.path}: "redirects" is not at the start of its line, so the layout is left to a person.`,
        );
      after = `${text.slice(0, arrayAt)}[${eol}${keyIndent}${unit}${oneLine(entry)}${eol}${keyIndent}]${text.slice(list2.close + 1)}`;
    } else {
      const lastText = text.slice(last.start, last.end);
      const indent = lineIndent(text, last.start);
      const before = list2.items.at(-2);
      if (indent !== undefined) {
        const body = lastText.includes("\n")
          ? expanded(entry, indent, unit, eol)
          : oneLine(entry, lastText);
        after = `${text.slice(0, last.end)},${eol}${indent}${body}${text.slice(last.end)}`;
      } else {
        // Entries share a line with the bracket or each other: the new one goes after the last, spaced like them.
        const sep = before
          ? text.slice(before.end, last.start)
          : `,${/^\{\s/.test(lastText) ? " " : ""}`;
        after = `${text.slice(0, last.end)}${sep}${oneLine(entry, lastText)}${text.slice(last.end)}`;
      }
    }
  }
  // The whole file must still be valid JSON, and the new entry the only difference.
  try {
    const next = JSON.parse(after) as { redirects?: unknown[] };
    const nextList = next.redirects ?? [];
    if (
      JSON.stringify(nextList.slice(-1)[0]) !== JSON.stringify(entry) ||
      nextList.length !== (list ?? []).length + 1
    )
      return refuse(
        `${file.path}: the change did not come out as one added redirect, so it is not proposed.`,
      );
  } catch {
    return refuse(`${file.path}: the change did not leave valid JSON, so it is not proposed.`);
  }
  return { path: file.path, before: text, after };
}

/** One redirect on one line, spaced like `like` (the entry before it) when there is one. */
function oneLine(entry: object, like?: string): string {
  let out = JSON.stringify(entry);
  if (like === undefined || /"\s*:\s/.test(like)) out = out.replace(/":/g, '": ');
  if (like === undefined || /,\s+"/.test(like)) out = out.replace(/,"/g, ', "');
  return like === undefined || /^\{\s/.test(like) ? `{ ${out.slice(1, -1)} }` : out;
}

/** One redirect over several lines, its members one unit deeper than `indent`. */
function expanded(entry: object, indent: string, unit: string, eol: string): string {
  const lines = Object.entries(entry).map(
    ([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  return `{${eol}${lines.join(`,${eol}`)}${eol}${indent}}`;
}

// --- Choosing the file ---------------------------------------------------------------------------

/**
 * The change that adds `request` to the project's one redirect file, or the reason the fixer is not
 * certain. `files` are the project's files (only the names matter until one is chosen).
 */
export function fixRedirect(
  files: readonly RepoFile[],
  request: RedirectRequest,
): FileChange | Refusal {
  const bad = checkRequest(request);
  if (bad) return bad;
  const candidates = files.filter(
    (f) => !SKIPPED.test(f.path) && /(^|\/)(_redirects|vercel\.json)$/.test(f.path),
  );
  if (candidates.length === 0)
    return refuse("There is no redirect file (_redirects or vercel.json) in the project.");
  if (candidates.length > 1)
    return refuse(
      `There is more than one redirect file (${candidates.map((c) => c.path).join(", ")}): a person says which one the site uses.`,
    );
  const file = candidates[0] as RepoFile;
  return file.path.endsWith("vercel.json") ? fixVercel(file, request) : fixNetlify(file, request);
}

/**
 * A proposal for a plan-redirect-missing finding. Only an old address that answered 404 or 410 gets one:
 * an address that still serves a page may keep serving it whatever the config says.
 */
export function redirectProposal(
  files: readonly RepoFile[],
  finding: Proposal["finding"],
  request: RedirectRequest,
  repository?: string | null,
): Proposal | Refusal {
  if (finding.checkId !== "plan-redirect-missing")
    return refuse(`${finding.checkId} is not a missing redirect.`);
  if (!/ returns (404|410): nothing redirects it$/.test(finding.evidence))
    return refuse(
      `${request.from} still serves a page, so a redirect rule may not take over from it: a person decides.`,
    );
  const change = fixRedirect(files, request);
  if (isRefusal(change)) return change;
  return buildProposal({
    ...change,
    fixer: "redirect",
    summary: `Redirect ${request.from} to ${request.to}`,
    finding,
    target: { repository: repository ?? null, path: change.path },
    recheck: {
      checkId: "plan-redirect-missing",
      how: `Request ${request.from} on the pull request's preview: it must answer 301 to ${request.to} (gaugeline plan <plan> --base <preview>).`,
    },
  });
}
