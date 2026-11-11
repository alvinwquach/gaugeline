import { LIBRARY_NAMES, type LibraryId } from "./advisories.js";
import { FINGERPRINTS, urlRules, type Fingerprint } from "./fingerprints.js";
import { parseVersion } from "./version.js";

/** How much of a file's text is searched: the first 2 MiB of characters (the reader also asks the fetcher to stop at 2 MiB of bytes). */
export const MAX_SCRIPT_CHARS = 2 * 1024 * 1024;

/**
 * How a library was recognised: a `banner` comment, a `version-string` in the code, the `file-name` or path of the
 * script's address, or its `name` alone (a license line, with no version written).
 */
export type EvidenceKind = "banner" | "version-string" | "file-name" | "name";

/**
 * One library found in a script. `evidence.matched` is the version string that was read, and nothing else from the
 * file; for a library recognised with no version it is the file name (from the address) or empty. Never script text.
 */
export interface Detection {
  library: LibraryId;
  /** The name a finding uses ("jQuery"). */
  name: string;
  /** The version as written, or null when the library was recognised and no version was found. */
  version: string | null;
  evidence: { how: EvidenceKind; matched: string };
}

/** The path of an address, lower case, with no query or fragment; "" when it is not an address. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

const RULES = new Map(FINGERPRINTS.map((f) => [f.id, urlRules(f)]));

const valid = (v: string | undefined): v is string =>
  v !== undefined && parseVersion(v) !== undefined;

function one(f: Fingerprint, text: string, path: string): Detection | undefined {
  const name = LIBRARY_NAMES[f.id];
  const make = (version: string | null, how: EvidenceKind, matched: string): Detection => ({
    library: f.id,
    name,
    version,
    evidence: { how, matched },
  });
  for (const rule of f.body) {
    const v = rule.find(text);
    if (valid(v)) return make(v, rule.how, v);
  }
  const rules = RULES.get(f.id);
  if (rules) {
    const own = rules.file.exec(path)?.[1];
    if (valid(own)) return make(own, "file-name", own);
    if (rules.bare.test(path)) {
      // The file is the library's own: a version in a folder of its path (a CDN's /jquery/1.12.4/) is its version.
      for (const re of rules.folders) {
        const v = re.exec(path)?.[1];
        if (valid(v)) return make(v, "file-name", v);
      }
      return make(null, "file-name", path.slice(path.lastIndexOf("/") + 1));
    }
  }
  if (f.named?.test(text)) return make(null, "name", "");
  return undefined;
}

/**
 * Which libraries a script is, and which version, from its text (a banner comment, a version string) and its
 * address (a file name or a CDN path such as /jquery/1.12.4/ or lodash@4.17.21). The file's own text is trusted
 * before its address. The text is data: it is only matched against fixed patterns, never run, and only the version
 * string is kept. A bundle can hold several libraries, so the answer is a list, in the table's order. The same
 * input gives the same answer.
 */
export function detect(scriptText: string, url: string): Detection[] {
  const text =
    scriptText.length > MAX_SCRIPT_CHARS ? scriptText.slice(0, MAX_SCRIPT_CHARS) : scriptText;
  const path = pathOf(url);
  const out: Detection[] = [];
  for (const f of FINGERPRINTS) {
    const d = one(f, text, path);
    if (d) out.push(d);
  }
  return out;
}

/** A line this long is a minified bundle, not code someone reads. */
const MINIFIED_LINE = 1000;

/** True when some line of the text is longer than 1,000 characters: how a minified file looks. */
export function looksMinified(text: string): boolean {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    if (stop - start >= MINIFIED_LINE) return true;
    start = stop + 1;
  }
  return false;
}
