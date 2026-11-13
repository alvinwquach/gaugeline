/**
 * The registered draft kinds and the fixed shape of each payload (G37, ADR-0010 parts 1 and 8). A payload
 * is checked against its kind before a decision is recorded, both the agent's original and a person's edit,
 * and the writer checks it again before it sends anything. Unknown keys are refused, so a payload cannot
 * carry a branch, a target repository, a recipient or a flag: the writer fixes those itself.
 *
 * This file is the writer's copy of apps/hosted/inbox/kinds.ts, with the longer list of paths the writer
 * never writes added. A test (kinds-parity.test.ts) holds the two together: anything the writer accepts, the
 * inbox accepts.
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
 * paragraph separators (U+2028, U+2029). A single-line field (`newlines` false) also refuses the
 * bidirectional controls (U+202A to U+202E, U+2066 to U+2069), which can make a title read in another
 * order than it is written, and the non-characters U+FFFE and U+FFFF. Mirrored by
 * private.draft_text_problem in 0005.
 */
function hasControl(text: string, newlines: boolean): boolean {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x09 || (newlines && c === 0x0a)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    if (!newlines && ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c >= 0xfffe))
      return true;
  }
  return false;
}

/** One line of 1 to `max` characters: no newline, no control or bidirectional-control character. */
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
 * Names the writer never writes, at any depth and in any letter case: the files a repository's own
 * automation runs. The branch lives in the customer's own repository, so a pull request from it can
 * start CI that reads the repository's secrets; a file that defines or hooks that automation is not a
 * draft a fixer may propose. This is a deny-list, not a boundary: any source file a CI job runs is code
 * too. The boundary is the per-site `allowedPrefixes` in the worker's configuration, and the customer's
 * own setting for workflows on non-default branches (docs/hosted/writer.md).
 */
const DENIED_NAMES: ReadonlySet<string> = new Set(
  [
    ".husky",
    ".circleci",
    ".devcontainer",
    ".vscode",
    ".buildkite",
    ".yarn",
    ".pnp.cjs",
    ".npmrc",
    ".pre-commit-config.yaml",
    ".travis.yml",
    ".drone.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    "codeowners",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
    "makefile",
    "justfile",
    "rakefile",
    "jenkinsfile",
    "taskfile.yml",
    "taskfile.yaml",
  ].map((n) => n.toLowerCase()),
);
/** Prefixes of a name: `.git*` (.git, .gitmodules, .gitattributes, .gitlab-ci.yml), `.yarnrc*`, `Dockerfile*`, `docker-compose*`; .github falls under .git. */
const DENIED_PREFIXES = [".git", ".yarnrc", "dockerfile", "docker-compose"] as const;
/** Scripts a shell or a runner starts, and any lock file. */
const DENIED_SUFFIX = /\.(sh|bash|zsh|ps1|bat|cmd|lock)$/;

/** True when one path segment names something the writer never writes. */
function isDeniedName(segment: string): boolean {
  // Trailing dots are ignored by Windows, so "package.json." is package.json there.
  const n = segment.toLowerCase().replace(/\.+$/, "");
  return (
    DENIED_NAMES.has(n) || DENIED_PREFIXES.some((p) => n.startsWith(p)) || DENIED_SUFFIX.test(n)
  );
}

/**
 * A relative path inside a repository: no leading "/" or "-", no "." or ".." segment (nor any segment
 * made only of dots), plain characters only, and no segment from the deny-list above (at any depth:
 * `x/.git/config`, `docs/CODEOWNERS`). The inbox's own copy of this rule (apps/hosted/inbox/kinds.ts,
 * mirrored in the database) is the shorter list; a test holds that nothing the writer accepts is refused
 * by the inbox's shape checks except through this list.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (!/^[A-Za-z0-9._@()[\]-]+(\/[A-Za-z0-9._@()[\]-]+)*$/.test(path)) return false;
  return path.split("/").every((segment) => {
    if (segment.startsWith("-")) return false;
    const name = segment.replace(/\.+$/, "");
    return name !== "" && !isDeniedName(segment);
  });
}

/**
 * True when `path` is inside one of the site's allowed prefixes (`content/`, `docs/menu.md`). A prefix
 * ending in "/" is a folder; any other prefix is that exact file. No prefixes at all means no limit
 * beyond the deny-list. Compared in lower case, so a letter-case trick cannot step outside a folder.
 */
export function isAllowedPath(path: string, prefixes: readonly string[] | undefined): boolean {
  if (prefixes === undefined) return true;
  const p = path.toLowerCase();
  return prefixes.some((raw) => {
    const prefix = raw.toLowerCase();
    return prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix;
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
  // Two paths that differ only by case collide on a case-insensitive checkout (Windows, macOS): one would
  // silently replace the other. Paths are plain ASCII, so toLowerCase and Postgres's lower() agree.
  .refine((p) => new Set(p.files.map((f) => f.path.toLowerCase())).size === p.files.length, {
    message: "names a path twice (case aside)",
    path: ["files"],
  });

/** A mailbox draft. Recipients are never in the payload: the writer takes them from the site's contacts. */
const email = z.strictObject({ subject: line(200), body: prose(20_000) });

/**
 * A number whose text is the same in JSON and in jsonb, and whose value survives the writer's JSON.parse:
 * either zero or between 1e-6 and 1e15 in size (where JavaScript never switches to exponent notation and
 * jsonb prints the full digits), and with at most 15 significant digits. A double needing 16 or 17
 * (0.1 + 0.2) is refused because the database holds exact decimals: the text a person approves would be
 * a different number from the one the writer parses. Mirrored by private.draft_payload_problem in 0005,
 * which compares the value with its round trip through float8.
 */
const plainNumber = z
  .number()
  .refine((n) => n === 0 || (Math.abs(n) >= 1e-6 && Math.abs(n) < 1e15), "is out of range")
  .refine((n) => n === 0 || Number(n.toPrecision(15)) === n, "has more than 15 significant digits");

/** A Sanity field name: it starts with a letter, so Sanity's own `_id`, `_type`, `_rev` can never be set. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * One Sanity document's fields. The writer adds the `drafts.` prefix; the payload cannot name it. `before`
 * holds, for each field in `set`, the SHA-256 (lower-case hex) of the field's live value when the fix
 * was proposed, so the writer can refuse a draft whose live value changed since (X71). The hash is of
 * the value's canonical JSON text (packages/writer/src/sanity/hash.ts), never the value: the approval row
 * stores digests of what a person saw, not the client's content.
 */
const sanityDraft = z
  .strictObject({
    documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "is not a plain document id"),
    documentType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "is not a document type"),
    // Names have no dots, so there are no nested paths to check.
    set: z
      .record(
        z.string().regex(FIELD_NAME, "is not a plain field name"),
        z.union([prose(2_000), plainNumber, z.boolean(), z.null()]),
      )
      .refine(
        (o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 20,
        "sets 1 to 20 fields",
      ),
    before: z.record(
      z.string().regex(FIELD_NAME, "is not a plain field name"),
      z.string().regex(/^[0-9a-f]{64}$/, "is not a SHA-256 digest in lower-case hex"),
    ),
  })
  .refine(
    (p) => {
      const a = Object.keys(p.set).sort();
      const b = Object.keys(p.before).sort();
      return a.length === b.length && a.every((k, i) => k === b[i]);
    },
    { message: "names the same fields as set", path: ["before"] },
  );

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
