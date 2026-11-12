/**
 * The pull request payload is a fixed shape, checked strictly before anything is sent: page-derived text
 * may sit in the title or body as quoted prose, but it never chooses a branch, a target repository, a
 * commit message or a file outside the repository's ordinary source (N17, ADR-0010 part 8).
 */
export interface PullRequestPayload {
  title: string;
  body: string;
  files: { path: string; content: string }[];
}

export class PayloadError extends Error {}

const MAX_FILES = 20;
const MAX_CONTENT = 100_000;
// Printable text plus tab and newline; no NUL, escape or other control characters.
const CONTROL = {
  test: (text: string): boolean =>
    [...text].some((ch) => {
      const c = ch.charCodeAt(0);
      return (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f;
    }),
};

/**
 * A relative path inside the repository: no leading slash, no "." or ".." segment, nothing under .git
 * or .github (workflows run with the repository's secrets), plain characters only.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (!/^[A-Za-z0-9._@()[\]-]+(\/[A-Za-z0-9._@()[\]-]+)*$/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "." || p === "..")) return false;
  const top = parts[0]!.toLowerCase();
  return top !== ".git" && top !== ".github";
}

function exactKeys(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new PayloadError(`${what} must be an object`);
  }
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw new PayloadError(`${what} has unknown keys: ${extra.join(", ")}`);
  for (const k of keys)
    if (typeof o[k] !== "string" && k !== "files") {
      throw new PayloadError(`${what}.${k} must be a string`);
    }
  return o;
}

export function parsePullRequestPayload(v: unknown): PullRequestPayload {
  const o = exactKeys(v, ["title", "body", "files"], "payload");
  const title = o.title as string;
  const body = o.body as string;
  if (title.trim() === "" || title.length > 200 || /[\r\n]/.test(title) || CONTROL.test(title)) {
    throw new PayloadError("payload.title must be one line of 1 to 200 characters");
  }
  if (body.length > 20_000 || CONTROL.test(body)) {
    throw new PayloadError("payload.body must be text of at most 20000 characters");
  }
  if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > MAX_FILES) {
    throw new PayloadError(`payload.files must hold 1 to ${MAX_FILES} files`);
  }
  const files = o.files.map((f, i) => {
    const e = exactKeys(f, ["path", "content"], `payload.files[${i}]`);
    const path = e.path as string;
    const content = e.content as string;
    if (!isSafeRepoPath(path)) throw new PayloadError(`payload.files[${i}].path is not allowed`);
    if (content.length > MAX_CONTENT) throw new PayloadError(`payload.files[${i}] is too large`);
    return { path, content };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) {
    throw new PayloadError("payload.files names a path twice");
  }
  return { title, body, files };
}
