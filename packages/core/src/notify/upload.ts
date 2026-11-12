import { createHash } from "node:crypto";
import type { Result } from "../result.js";
import { secretsIn } from "../secrets.js";
import { postJson, safeTarget } from "./post.js";

/**
 * Upload a run's result to the person's own hosted workspace (G35). Like every send in this folder it goes
 * through post.ts, the one file that sends a POST, to an address the person gave (GAUGELINE_UPLOAD_URL),
 * at their request (--upload). It never throws and never changes an exit code: the answer is one plain line.
 */
export const UPLOAD_TOKEN_ENV = "GAUGELINE_TOKEN";
export const UPLOAD_URL_ENV = "GAUGELINE_UPLOAD_URL";
export const UPLOAD_TIMEOUT_MS = 30_000;

export interface UploadOutcome {
  ok: boolean;
  /** One line, no newline, safe to print: the host only, never the token or the address's path. */
  line: string;
}

/** The same result gives the same key, so a retried upload (a re-run of a failed CI job) is one run. */
export function uploadKey(result: Result): string {
  return `gl-${createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0, 32)}`;
}

/** https, or http to this machine only (a developer's own server): the token is a credential. */
function runsAddress(base: string): string | undefined {
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    return undefined;
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  if (u.username || u.password) return undefined;
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/runs`;
  return u.href;
}

/** One line that ends like a sentence. */
const stop = (s: string): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(line) ? line : `${line}.`;
};

export async function uploadResult(
  result: Result,
  env: Record<string, string | undefined>,
  opts: { timeoutMs?: number } = {},
): Promise<UploadOutcome> {
  try {
    const token = env[UPLOAD_TOKEN_ENV]?.trim();
    if (!token)
      return {
        ok: false,
        line: `Not uploaded: set ${UPLOAD_TOKEN_ENV} to the site's upload token.`,
      };
    const base = env[UPLOAD_URL_ENV]?.trim();
    if (!base)
      return {
        ok: false,
        line: `Not uploaded: set ${UPLOAD_URL_ENV} to the hosted app's API address.`,
      };
    const address = runsAddress(base);
    if (!address)
      return { ok: false, line: `Not uploaded: ${UPLOAD_URL_ENV} must be an https address.` };
    // Findings and evidence lines only; if a key from this environment got in, none of it leaves.
    const body = JSON.stringify(result);
    const leaked = secretsIn(body, env);
    if (leaked.length > 0)
      return {
        ok: false,
        line: `Not uploaded: the result contains the value of ${leaked[0]}, so nothing was sent.`,
      };
    const sent = await postJson(address, result, {
      timeoutMs: opts.timeoutMs ?? UPLOAD_TIMEOUT_MS,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": uploadKey(result) },
      readError: true,
    });
    if (!sent.ok)
      return {
        ok: false,
        line: `Could not upload: ${stop(sent.error ?? `${safeTarget(address)} failed`)}`,
      };
    const n = result.findings.length;
    return {
      ok: true,
      line: `Uploaded ${n} ${n === 1 ? "finding" : "findings"} to ${safeTarget(address)}.`,
    };
  } catch {
    return { ok: false, line: "Could not upload: the upload failed." };
  }
}
