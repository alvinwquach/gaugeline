/**
 * The read-only SQL classifier: decides, before anything is sent to a database, whether a piece of
 * SQL is exactly one read.
 *
 * Attribution: the rules are those of the statement classifier in LocalQuery's read-only tier
 * (Tier 1). LocalQuery is a private repository, so Gaugeline cannot depend on it; the rules were
 * ported here, and the two copies are kept in step by one list of test cases,
 * classifier-cases.json in this folder, that LocalQuery imports a copy of. A gap found in either
 * copy becomes a case in that list and is fixed in both. (The port was written from
 * the rules the spec names, not from LocalQuery's source, which the build session could not read:
 * the case list is what proves the two agree.)
 *
 * What it does, in order:
 *  1. Reads the text the way Postgres does (with standard_conforming_strings on, which the
 *     connector sets): comments, nested block comments, quoted identifiers, plain, E'' and
 *     dollar-quoted strings are skipped, so a keyword inside one is not a keyword and a `;` inside
 *     one does not end a statement.
 *  2. Allows one statement, starting with SELECT or WITH, with no INSERT/UPDATE/DELETE/MERGE
 *     anywhere (so no data-modifying CTE), no INTO (SELECT INTO creates a table), no locking clause
 *     (FOR UPDATE / SHARE / NO KEY UPDATE / KEY SHARE), no parameter placeholder, no Unicode escape
 *     (they can spell a name the list would miss), and no function on the deny list.
 *  3. Says why in a sentence a person can act on, without repeating anything from a string
 *     (it may be someone's data).
 *
 * The classifier is the first of three layers, not the last. It is deliberately strict: it refuses
 * a bare column called `update` or `set` (quote it) rather than guess. What it cannot see, a
 * user-written function that writes, is stopped by the read-only transaction and the database role.
 */

export type RefusalReason =
  | "empty"
  | "too-long"
  | "multiple"
  | "not-select"
  | "write"
  | "into"
  | "locking"
  | "function"
  | "syntax";

export type Verdict =
  { ok: true; sql: string } | { ok: false; reason: RefusalReason; message: string };

/** Longest statement accepted. A named query is a sentence of SQL, not a script. */
export const MAX_STATEMENT_CHARS = 20_000;

/**
 * Functions refused by default: they change something, reach outside the database, read the
 * server's files, run another query from a string, hold a lock, or wait. A trailing `*` means
 * "every name that starts with this". A source's config can add more; nothing removes these.
 */
export const DEFAULT_DENIED_FUNCTIONS: readonly string[] = Object.freeze([
  // Stop, signal or reconfigure the server.
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "set_config",
  "pg_stat_reset*",
  "pg_log_backend_memory_contexts",
  // Large objects, which read and write server files.
  "lo_*",
  "lowrite",
  "loread",
  // The server's files and directories.
  "pg_read_*",
  "pg_ls_*",
  "pg_stat_file",
  // Waiting, holding locks, sequences and messages.
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_advisory*",
  "pg_try_advisory*",
  "nextval",
  "setval",
  "pg_notify",
  "pg_logical_emit_message",
  // Other connections and queries run from a string.
  "dblink*",
  "query_to_xml*",
  "table_to_xml*",
  "cursor_to_xml",
  "schema_to_xml*",
  "database_to_xml*",
  "ts_stat",
  // Backups, replication and extensions.
  "pg_create_*",
  "pg_drop_*",
  "pg_switch_*",
  "pg_promote",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_backup_*",
  "pg_wal_replay_*",
  "pg_replication_*",
  "pg_import_*",
  "pg_extension_config_dump",
  "pg_prewarm",
]);

/** Words that turn a read into a write. A WITH body may hold one, so they are refused anywhere. */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
]);

/** Statements that are not reads. Refused anywhere; quote the name if it is a column. */
const STATEMENT_WORDS: ReadonlySet<string> = new Set([
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "execute",
  "prepare",
  "deallocate",
  "vacuum",
  "analyze",
  "analyse",
  "reindex",
  "cluster",
  "refresh",
  "listen",
  "notify",
  "unlisten",
  "discard",
  "reset",
  "set",
  "lock",
  "explain",
  "begin",
  "commit",
  "rollback",
  "abort",
  "savepoint",
  "checkpoint",
]);

type TokenKind = "word" | "quoted" | "string" | "number" | "param" | "punct";
interface Token {
  kind: TokenKind;
  /** A word is lower-cased; a quoted identifier is its characters without the quotes. */
  text: string;
  /** Where the token starts in the text. */
  start: number;
}

class Unreadable extends Error {}

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
/** Postgres whitespace is exactly these; a no-break space is part of a name. */
const isSpace = (c: string): boolean => c === " " || "\t\n\r\f\v".includes(c);

/**
 * The tokens of a statement with comments and the insides of strings removed. Throws Unreadable
 * for anything that is not complete, since Postgres would refuse it too. Linear in the text: no
 * backtracking, and nesting is a counter.
 */
function lex(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  let start = 0;
  const push = (kind: TokenKind, text: string): void => void out.push({ kind, text, start });
  while (i < n) {
    const c = sql[i] as string;
    start = i;
    if (c === "\0") throw new Unreadable("The text contains a NUL character.");
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) throw new Unreadable("A /* comment is never closed.");
      continue;
    }
    if (c === "'") {
      i = skipString(sql, i, false);
      push("string", "");
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= n) throw new Unreadable("A double-quoted name is never closed.");
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            name += '"';
            j += 2;
            continue;
          }
          break;
        }
        name += sql[j];
        j++;
      }
      i = j + 1;
      push("quoted", name);
      continue;
    }
    if (c === "$") {
      const next = sql[i + 1] ?? "";
      if (isDigit(next)) {
        let j = i + 1;
        while (j < n && isDigit(sql[j] as string)) j++;
        i = j;
        push("param", "$");
        continue;
      }
      // $$ or $tag$: a string that ends at the same marker.
      let j = i + 1;
      if (isIdentStart(next) && next !== "$") {
        while (j < n && isIdentPart(sql[j] as string) && sql[j] !== "$") j++;
      }
      if (sql[j] === "$") {
        const marker = sql.slice(i, j + 1);
        const close = sql.indexOf(marker, j + 1);
        if (close === -1) throw new Unreadable("A $$ string is never closed.");
        i = close + marker.length;
        push("string", "");
        continue;
      }
      push("punct", "$");
      i++;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j] as string)) j++;
      const word = sql.slice(i, j).toLowerCase();
      const next = sql[j];
      if (next === "'" && word === "e") {
        i = skipString(sql, j, true);
        push("string", "");
        continue;
      }
      if (word === "u" && next === "&" && (sql[j + 1] === "'" || sql[j + 1] === '"'))
        throw new Unreadable("A U& string or name (a Unicode escape) is not allowed.");
      i = j;
      push("word", word);
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(sql[i + 1] ?? ""))) {
      let j = i;
      while (j < n && isDigit(sql[j] as string)) j++;
      if (sql[j] === "." && isDigit(sql[j + 1] ?? "")) {
        j++;
        while (j < n && isDigit(sql[j] as string)) j++;
      } else if (sql[j] === "." && c !== ".") {
        j++;
      }
      if ((sql[j] === "e" || sql[j] === "E") && /^[+-]?\d/.test(sql.slice(j + 1, j + 3))) {
        j += 2;
        while (j < n && isDigit(sql[j] as string)) j++;
      }
      i = j;
      push("number", "");
      continue;
    }
    push("punct", c);
    i++;
  }
  return out;
}

/** The index just past the string that opens at `open`. Backslash escapes only in an E string. */
function skipString(sql: string, open: number, escapes: boolean): number {
  let j = open + 1;
  for (;;) {
    if (j >= sql.length) throw new Unreadable("A quoted string is never closed.");
    const c = sql[j];
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      if (sql[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
}

function deniedBy(name: string, list: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  return list.find((entry) =>
    entry.endsWith("*") ? lower.startsWith(entry.slice(0, -1)) : lower === entry,
  );
}

const REJECT_PREFIX = "Gaugeline only reads";

function refuse(reason: RefusalReason, message: string): Verdict {
  return { ok: false, reason, message };
}

export interface ClassifyOptions {
  /** More function names to refuse (a trailing `*` means "starts with"). Added to the defaults. */
  denyFunctions?: readonly string[];
}

/**
 * Whether `sql` is exactly one read. On success `sql` is the same text without one final
 * semicolon, which is what should be sent. On refusal the message is one plain sentence.
 */
export function classifyStatement(sql: string, options: ClassifyOptions = {}): Verdict {
  if (typeof sql !== "string" || sql.trim() === "")
    return refuse("empty", "The query is empty. Write a SELECT.");
  if (sql.length > MAX_STATEMENT_CHARS)
    return refuse(
      "too-long",
      `The query is longer than ${MAX_STATEMENT_CHARS} characters. A named query should be one short SELECT.`,
    );
  let tokens: Token[];
  try {
    tokens = lex(sql);
  } catch (err) {
    if (err instanceof Unreadable)
      return refuse("syntax", `${err.message} ${REJECT_PREFIX} a complete, single SELECT.`);
    throw err;
  }
  // One optional final ";" ends the statement; any other ";" starts another one.
  const last = tokens.at(-1);
  const body = last?.kind === "punct" && last.text === ";" ? tokens.slice(0, -1) : tokens;
  if (body.length === 0) return refuse("empty", "The query is empty. Write a SELECT.");
  if (body.some((t) => t.kind === "punct" && t.text === ";"))
    return refuse(
      "multiple",
      `More than one statement was sent. ${REJECT_PREFIX} one SELECT at a time: remove the extra ; and what follows it.`,
    );

  const first = body[0] as Token;
  const firstWord = first.kind === "word" ? first.text : "";
  if (firstWord !== "select" && firstWord !== "with") {
    if (WRITE_WORDS.has(firstWord))
      return refuse(
        "write",
        `${firstWord.toUpperCase()} changes data. ${REJECT_PREFIX}: start the query with SELECT or WITH.`,
      );
    return refuse("not-select", `${REJECT_PREFIX}: start the query with SELECT or WITH.`);
  }

  const denyList = [
    ...DEFAULT_DENIED_FUNCTIONS,
    ...(options.denyFunctions ?? []).map((f) => f.toLowerCase()),
  ];
  for (let i = 0; i < body.length; i++) {
    const t = body[i] as Token;
    const prev = body[i - 1];
    // A name after a dot (t.update, pg_catalog.set_config) is a name, not a keyword; it is still
    // checked against the function list below.
    const qualified = prev?.kind === "punct" && prev.text === ".";
    if (t.kind === "param")
      return refuse(
        "syntax",
        `A parameter ($1) has no value here. ${REJECT_PREFIX} a complete SELECT.`,
      );
    if (t.kind === "word" && !qualified) {
      if (WRITE_WORDS.has(t.text))
        return refuse(
          "write",
          `${t.text.toUpperCase()} changes data, even inside WITH. ${REJECT_PREFIX}. If "${t.text}" is a column name, put it in double quotes.`,
        );
      if (t.text === "into")
        return refuse("into", `SELECT ... INTO creates a table. ${REJECT_PREFIX}: remove INTO.`);
      if (t.text === "for") {
        const nextWord = body[i + 1]?.kind === "word" ? (body[i + 1] as Token).text : "";
        if (["update", "share", "no", "key"].includes(nextWord))
          return refuse(
            "locking",
            `FOR ${nextWord.toUpperCase()} takes a lock on rows. ${REJECT_PREFIX}: remove the locking clause.`,
          );
      }
      if (STATEMENT_WORDS.has(t.text))
        return refuse(
          "not-select",
          `${t.text.toUpperCase()} is not part of a read. ${REJECT_PREFIX}. If "${t.text}" is a column name, put it in double quotes.`,
        );
    }
    if (t.kind === "word" || t.kind === "quoted") {
      const hit = deniedBy(t.text, denyList);
      if (hit !== undefined)
        return refuse(
          "function",
          `${t.text.toLowerCase()} is on the list of functions Gaugeline will not call (it can change something or reach outside the database).`,
        );
    }
  }
  // Everything from the final ";" on is that semicolon and nothing else, since only space and
  // comments can follow it.
  return {
    ok: true,
    sql: body.length === tokens.length ? sql : sql.slice(0, (last as Token).start),
  };
}
