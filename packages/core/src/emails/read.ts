import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { ConfigError } from "../errors.js";

/** Emails read from one folder, at most. A folder of exports is dozens, not thousands. */
export const MAX_EMAILS = 200;
/** Gmail cuts a message at about 100 KB; a file past a megabyte is not an email. */
export const MAX_EMAIL_BYTES = 1024 * 1024;
/** How deep under the folder emails are looked for. */
export const MAX_DEPTH = 4;

export interface EmailSource {
  /** The path inside the folder, with "/" separators. */
  file: string;
  html: string;
  /** The .txt with the same name beside it. */
  text?: { file: string; body: string };
}

export interface EmailFolder {
  emails: EmailSource[];
  /** What was left out and why: a file too large, a link, a folder past the cap. */
  notes: string[];
}

const posix = (p: string): string => p.split(sep).join("/");
const HTML = /\.html?$/i;

function decode(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * Rendered emails in a folder (or one .html file): every .html or .htm file under it, in name order,
 * each with the .txt of the same name beside it. Files are read as bytes and decoded as UTF-8, so
 * CRLF stays as it is and the parser deals with it. Links are never followed, nothing is run.
 */
export function readEmailFolder(dir: string, typed = dir): EmailFolder {
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    throw new ConfigError(`The folder ${typed} does not exist.`, {
      hint: "Give the folder your email export wrote: gaugeline emails ./emails",
    });
  }
  const notes: string[] = [];
  const found: string[] = [];
  const texts = new Set<string>();
  let skippedLinks = 0;
  let tooDeep = 0;
  if (info.isFile()) {
    if (!HTML.test(dir))
      throw new ConfigError(`${typed} is not an .html file.`, {
        hint: "Give a rendered email (order.html) or the folder that holds them.",
      });
    found.push(basename(dir));
  } else if (info.isDirectory()) {
    const walk = (folder: string, depth: number): void => {
      const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(folder, e.name);
        if (e.isSymbolicLink()) {
          skippedLinks += 1;
        } else if (e.isDirectory()) {
          if (depth + 1 > MAX_DEPTH) tooDeep += 1;
          else walk(full, depth + 1);
        } else if (e.isFile()) {
          const rel = posix(relative(dir, full));
          if (HTML.test(e.name)) found.push(rel);
          else if (/\.txt$/i.test(e.name)) texts.add(rel);
        }
      }
    };
    walk(dir, 0);
  } else {
    throw new ConfigError(`${typed} is neither a folder nor a file.`);
  }
  if (skippedLinks > 0)
    notes.push(
      `${skippedLinks} link${skippedLinks === 1 ? "" : "s"} to files or folders left unread.`,
    );
  if (tooDeep > 0)
    notes.push(
      `${tooDeep} folder${tooDeep === 1 ? "" : "s"} deeper than ${MAX_DEPTH} levels left unread.`,
    );
  if (found.length === 0)
    throw new ConfigError(`No .html emails in ${typed}.`, {
      hint: "Export your emails as HTML first (docs/guides/emails), then point this at the folder.",
    });
  const wanted = found.slice(0, MAX_EMAILS);
  if (found.length > wanted.length)
    notes.push(
      `Read the first ${MAX_EMAILS} of ${found.length} emails, in name order; the rest were left out.`,
    );
  // The .txt files by lower-case name, so a Map lookup finds the text beside an email.
  const textsByName = new Map([...texts].map((t) => [t.toLowerCase(), t] as const));
  const emails: EmailSource[] = [];
  const root = info.isFile() ? undefined : dir;
  for (const file of wanted) {
    const path = root === undefined ? dir : join(root, ...file.split("/"));
    const bytes = readFileSync(path);
    if (bytes.length > MAX_EMAIL_BYTES) {
      notes.push(`${file} is over 1 MB, which is not an email, and was left unread.`);
      continue;
    }
    const email: EmailSource = { file, html: decode(bytes) };
    const textFile = file.replace(HTML, ".txt");
    const textKey = textsByName.get(textFile.toLowerCase());
    if (root !== undefined && textKey !== undefined) {
      const tb = readFileSync(join(root, ...textKey.split("/")));
      if (tb.length <= MAX_EMAIL_BYTES) email.text = { file: textKey, body: decode(tb) };
    } else if (root === undefined) {
      // A single file: its text version is the .txt beside it, if any.
      try {
        const tb = readFileSync(dir.replace(HTML, ".txt"));
        if (tb.length <= MAX_EMAIL_BYTES)
          email.text = { file: basename(dir).replace(HTML, ".txt"), body: decode(tb) };
      } catch {
        // none beside it
      }
    }
    emails.push(email);
  }
  if (emails.length === 0)
    throw new ConfigError(`No email in ${typed} could be read.`, { hint: notes.join(" ") });
  return { emails, notes };
}
