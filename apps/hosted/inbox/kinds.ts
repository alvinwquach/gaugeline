/**
 * The registered draft kinds and the fixed shape of each payload (G37, ADR-0010 parts 1 and 8). A payload
 * is checked against its kind before a decision is recorded, both the agent's original and a person's edit,
 * and the writer checks it again before it sends anything. Unknown keys are refused, so a payload cannot
 * carry a branch, a target repository, a recipient or a flag: the writer fixes those itself.
 *
 * The writer package (packages/writer, part 2) imports these schemas rather than copying them.
 */
import * as z from "zod";

export const DRAFT_KINDS = ["pull_request", "email", "sanity_draft"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export function isDraftKind(kind: string): kind is DraftKind {
  return (DRAFT_KINDS as readonly string[]).includes(kind);
}

/**
 * The most a payload (or an edit of one) may be: octet_length(payload::text) in the database, which the
 * drafts and decisions tables enforce (migrations 0001 and 0005). It is measured on the jsonb text.
 */
export const MAX_PAYLOAD_BYTES = 16_384;

/** The most findings one draft may name (a CHECK on drafts, 0005). */
export const MAX_FINDING_IDS = 50;

/**
 * True when `text` has a control or line-breaking character other than tab and (when allowed) newline:
 * C0 controls, DEL, C1 controls (U+0080 to U+009F, which include NEL, U+0085) and the Unicode line and
 * paragraph separators (U+2028, U+2029). Mirrored by private.draft_text_problem in 0005.
 */
function hasControl(text: string, newlines: boolean): boolean {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x09 || (newlines && c === 0x0a)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** One line of 1 to `max` characters: no newline, no control character. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !hasControl(s, false), "must be one line without control characters");

/** Prose of at most `max` characters: newlines allowed, no other control character. */
const prose = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !hasControl(s, true), "must not contain control characters");

/**
 * Path segments a payload may never write, at any depth, whatever the case or trailing dots (Windows
 * ignores them): git's own directory and files (hooks run code), the CI and automation configuration
 * that runs with a repository's secrets (.github, .circleci, .gitlab-ci.yml), and git hooks managers.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".gitmodules",
  ".github",
  ".circleci",
  ".gitlab-ci.yml",
  ".husky",
]);

/**
 * A relative path inside a repository: no leading "/" or "-", no "." or ".." segment (nor any segment
 * made only of dots), none of FORBIDDEN_SEGMENTS at any depth, plain characters only. Mirrored by
 * private.draft_path_ok in 0005.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.startsWith("-")) return false;
  if (!/^[A-Za-z0-9._@()[\]-]+(\/[A-Za-z0-9._@()[\]-]+)*$/.test(path)) return false;
  return path.split("/").every((segment) => {
    if (segment.startsWith("-")) return false;
    const name = segment.toLowerCase().replace(/\.+$/, "");
    return name !== "" && !FORBIDDEN_SEGMENTS.has(name);
  });
}

const pullRequest = z
  .strictObject({
    title: line(200),
    body: prose(20_000),
    files: z
      .array(
        z.strictObject({
          path: z.string().refine(isSafeRepoPath, "is not an allowed repository path"),
          content: z.string().max(100_000),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine((p) => new Set(p.files.map((f) => f.path)).size === p.files.length, {
    message: "names a path twice",
    path: ["files"],
  });

/** A mailbox draft. Recipients are never in the payload: the writer takes them from the site's contacts. */
const email = z.strictObject({ subject: line(200), body: prose(20_000) });

/**
 * A number whose text is the same in JSON and in jsonb: finite, and either zero or between 1e-6 and 1e15
 * in size, where JavaScript never switches to exponent notation (jsonb prints the full digits, so the
 * size check in checkDraftPayload would otherwise be wrong).
 */
const plainNumber = z
  .number()
  .refine((n) => n === 0 || (Math.abs(n) >= 1e-6 && Math.abs(n) < 1e15), "is out of range");

/** One Sanity document's fields. The writer adds the `drafts.` prefix; the payload cannot name it. */
const sanityDraft = z.strictObject({
  documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "is not a plain document id"),
  documentType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "is not a document type"),
  // A field name starts with a letter: the underscore names are Sanity's own (_id, _type, _rev, ...), set
  // by the content system, never by a draft. Names have no dots, so there are no nested paths to check.
  set: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "is not a plain field name"),
      z.union([prose(2_000), plainNumber, z.boolean(), z.null()]),
    )
    .refine(
      (o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 20,
      "sets 1 to 20 fields",
    ),
});

const SCHEMAS = { pull_request: pullRequest, email, sanity_draft: sanityDraft } as const;

export type PayloadCheck =
  { ok: true; value: Record<string, unknown> } | { ok: false; problems: string[] };

/**
 * The JSON text Postgres prints for a jsonb value (`{"a": 1, "b": [1, 2]}`: a space after each colon and
 * comma, which JSON.stringify leaves out), for the payloads this file admits: strings, numbers within
 * plainNumber's range, booleans, null, arrays and objects.
 */
export function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`)
      .join(", ")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A UTF-16 surrogate with no partner (no `u` flag, so the pattern sees code units). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * What the database cannot store, found before it is asked to: U+0000 (jsonb refuses it, error 22P05) and
 * an unpaired surrogate (error 22P02) in any string or key, and nesting past `depth`.
 */
function unstorable(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string")
    return value.includes("\u0000") || LONE_SURROGATE.test(value)
      ? "contains U+0000 or an unpaired surrogate"
      : undefined;
  if (value === null || typeof value !== "object") return undefined;
  if (depth > 8) return "is nested too deeply";
  for (const [k, v] of Object.entries(value)) {
    const problem = unstorable(k, depth + 1) ?? unstorable(v, depth + 1);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Check a payload against its kind's fixed shape and the database's own limits (so a payload that passes
 * here is one the tables accept). An unregistered kind is a problem, not an error.
 */
export function checkDraftPayload(kind: string, payload: unknown): PayloadCheck {
  if (!isDraftKind(kind)) return { ok: false, problems: [`kind ${kind} is not registered`] };
  const bad = unstorable(payload);
  if (bad) return { ok: false, problems: [`payload ${bad}`] };
  const r = SCHEMAS[kind].safeParse(payload);
  if (!r.success)
    return {
      ok: false,
      problems: r.error.issues.map((i) => `${["payload", ...i.path].join(".")} ${i.message}`),
    };
  const bytes = Buffer.byteLength(jsonbText(r.data), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES)
    return {
      ok: false,
      problems: [`payload is ${bytes} bytes; at most ${MAX_PAYLOAD_BYTES} are kept`],
    };
  return { ok: true, value: r.data as Record<string, unknown> };
}
