/**
 * The registered draft kinds and the fixed shape of each payload (G37, ADR-0010 parts 1 and 8). A payload
 * is checked against its kind before a decision is recorded, both the agent's original and a person's edit,
 * and the writer checks it again before it sends anything. Unknown keys are refused, so a payload cannot
 * carry a branch, a target repository, a recipient or a flag: the writer fixes those itself.
 *
 * One module for both sides: the hosted inbox imports it as `@gaugeline/writer/kinds` (it brings in
 * nothing that sends), and the writer checks every job against it again.
 */
import * as z from "zod";

export const DRAFT_KINDS = ["pull_request", "email", "sanity_draft"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export function isDraftKind(kind: string): kind is DraftKind {
  return (DRAFT_KINDS as readonly string[]).includes(kind);
}

/** True when `text` has a control character other than tab and (when allowed) newline. */
function hasControl(text: string, newlines: boolean): boolean {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x09 || (newlines && c === 0x0a)) continue;
    if (c < 0x20 || c === 0x7f) return true;
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
  const n = segment.toLowerCase();
  return (
    DENIED_NAMES.has(n) || DENIED_PREFIXES.some((p) => n.startsWith(p)) || DENIED_SUFFIX.test(n)
  );
}

/**
 * A relative path inside a repository: no leading "/" or "-", no "." or ".." segment, plain characters
 * only, and no segment from the deny-list above (at any depth: `x/.git/config`, `docs/CODEOWNERS`).
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (!/^[A-Za-z0-9._@()[\]-]+(\/[A-Za-z0-9._@()[\]-]+)*$/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "." || p === ".." || p.startsWith("-"))) return false;
  return !parts.some(isDeniedName);
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
  .refine((p) => new Set(p.files.map((f) => f.path)).size === p.files.length, {
    message: "names a path twice",
    path: ["files"],
  });

/** A mailbox draft. Recipients are never in the payload: the writer takes them from the site's contacts. */
const email = z.strictObject({ subject: line(200), body: prose(20_000) });

/** One Sanity document's fields. The writer adds the `drafts.` prefix; the payload cannot name it. */
const sanityDraft = z.strictObject({
  documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "is not a plain document id"),
  documentType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "is not a document type"),
  set: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      z.union([prose(2_000), z.number(), z.boolean(), z.null()]),
    )
    .refine(
      (o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 20,
      "sets 1 to 20 fields",
    ),
});

const SCHEMAS = { pull_request: pullRequest, email, sanity_draft: sanityDraft } as const;

export type PayloadCheck =
  { ok: true; value: Record<string, unknown> } | { ok: false; problems: string[] };

/** Check a payload against its kind's fixed shape. An unregistered kind is a problem, not an error. */
export function checkDraftPayload(kind: string, payload: unknown): PayloadCheck {
  if (!isDraftKind(kind)) return { ok: false, problems: [`kind ${kind} is not registered`] };
  const r = SCHEMAS[kind].safeParse(payload);
  if (r.success) return { ok: true, value: r.data as Record<string, unknown> };
  return {
    ok: false,
    problems: r.error.issues.map((i) => `${["payload", ...i.path].join(".")} ${i.message}`),
  };
}
