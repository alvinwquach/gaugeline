import { connectorGet } from "../connectors/http.js";
import { isRecord } from "../connectors/get-json.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { isoOf } from "./dates.js";

/** Where each token is read from. Dedicated names, so a deploy token a CI job already holds is never used by accident. */
export const GITHUB_TOKEN_VAR = "GAUGELINE_GITHUB_TOKEN";
export const VERCEL_TOKEN_VAR = "GAUGELINE_VERCEL_TOKEN";
export const RENEWALS_ENV_VARS = [GITHUB_TOKEN_VAR, VERCEL_TOKEN_VAR] as const;

/** What one token said about itself. A date, and where it came from: never the token. */
export interface TokenRead {
  provider: "GitHub" | "Vercel";
  /** The environment variable the token was read from. */
  variable: string;
  /** ISO time. Absent when the provider reports no expiry (a token with no expiration, or one the provider does not date). */
  expiresAt?: string;
  /** Why it could not be read: a refusal, a rate limit, an outage. Redacted. */
  failed?: string;
}

const set = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

/**
 * GitHub's "GitHub-Authentication-Token-Expiration" header, "2026-12-03 00:00:00 UTC" (older answers
 * wrote the offset, "-0800"), as an ISO time. Anything else is undefined.
 */
export function parseGithubExpiry(header: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|GMT|Z|[+-]\d{4})$/.exec(
    (header ?? "").trim(),
  );
  if (!m) return undefined;
  const zone =
    m[3] === "UTC" || m[3] === "GMT" || m[3] === "Z"
      ? "Z"
      : `${m[3]?.slice(0, 3)}:${m[3]?.slice(3)}`;
  return isoOf(`${m[1]}T${m[2]}${zone}`);
}

/** Vercel's expiresAt: milliseconds since the epoch (seconds are read too), as an ISO time. */
export function parseVercelExpiry(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value < 1e11 ? value * 1000 : value).toISOString();
}

async function guarded<T>(
  provider: TokenRead["provider"],
  variable: string,
  env: Env,
  read: () => Promise<T>,
  ok: (v: T) => TokenRead,
): Promise<TokenRead> {
  try {
    return ok(await read());
  } catch (err) {
    const redact = createRedactor(env, [variable]);
    const text = err instanceof Error ? err.message : "the read failed";
    return { provider, variable, failed: redact(`${provider} could not be read: ${text}`) };
  }
}

/**
 * The GitHub token's expiry: one GET of /rate_limit (which costs no quota and needs no scope) with the
 * token, reading the expiration header the answer carries. Nothing from the body is read.
 */
export function readGithubToken(env: Env, fetcher: Fetcher): Promise<TokenRead> | undefined {
  const token = set(env, GITHUB_TOKEN_VAR);
  if (!token) return undefined;
  return guarded(
    "GitHub",
    GITHUB_TOKEN_VAR,
    env,
    () =>
      connectorGet(fetcher, "https://api.github.com/rate_limit", {
        authorization: `Bearer ${token}`,
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      }),
    (hop) => {
      const expiresAt = parseGithubExpiry(hop.headers["github-authentication-token-expiration"]);
      return {
        provider: "GitHub",
        variable: GITHUB_TOKEN_VAR,
        ...(expiresAt ? { expiresAt } : {}),
      };
    },
  );
}

/** The Vercel token's expiry: GET /v5/user/tokens/current, reading expiresAt and nothing else. */
export function readVercelToken(env: Env, fetcher: Fetcher): Promise<TokenRead> | undefined {
  const token = set(env, VERCEL_TOKEN_VAR);
  if (!token) return undefined;
  return guarded(
    "Vercel",
    VERCEL_TOKEN_VAR,
    env,
    async () => {
      const hop = await connectorGet(fetcher, "https://api.vercel.com/v5/user/tokens/current", {
        authorization: `Bearer ${token}`,
      });
      return JSON.parse(hop.body ?? "") as unknown;
    },
    (body) => {
      const inner = isRecord(body) && isRecord(body.token) ? body.token : undefined;
      const expiresAt = parseVercelExpiry(inner?.expiresAt);
      return {
        provider: "Vercel",
        variable: VERCEL_TOKEN_VAR,
        ...(expiresAt ? { expiresAt } : {}),
      };
    },
  );
}

/** A Vercel project's Node.js setting, or why it could not be read. */
export interface ProjectRuntime {
  project: string;
  /** "22.x", as Vercel stores it. */
  nodeVersion?: string;
  failed?: string;
}

/** GET /v9/projects/<project>: only the nodeVersion field is read. */
export async function readVercelProject(
  env: Env,
  fetcher: Fetcher,
  project: string,
  teamId?: string,
): Promise<ProjectRuntime> {
  const token = set(env, VERCEL_TOKEN_VAR) ?? "";
  try {
    const hop = await connectorGet(
      fetcher,
      `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`,
      { authorization: `Bearer ${token}` },
    );
    const body: unknown = JSON.parse(hop.body ?? "");
    const v = isRecord(body) ? body.nodeVersion : undefined;
    return typeof v === "string" && v !== ""
      ? { project, nodeVersion: v }
      : { project, failed: `Vercel did not report a Node.js version for ${project}` };
  } catch (err) {
    const redact = createRedactor(env, [VERCEL_TOKEN_VAR]);
    return {
      project,
      failed: redact(
        `Vercel project ${project} could not be read: ${err instanceof Error ? err.message : "the read failed"}`,
      ),
    };
  }
}
