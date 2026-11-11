import { isRecord } from "../connectors/get-json.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { getProviderJson, type ProviderAccess } from "../handoff/http.js";
import type { ChangesConfig } from "./config.js";
import type { Deploy, SourceRead } from "./types.js";

export const VERCEL_TOKEN = "VERCEL_TOKEN";
export const NETLIFY_TOKEN = "NETLIFY_TOKEN";
/** Production deployments read in one question (the newest first). */
export const DEPLOYS_MAX = 100;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const iso = (v: unknown): string | undefined => {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/**
 * The site's production deployments from Vercel or Netlify, with the git commit the host says it
 * built. One GET, read token from the environment. Endpoint shapes are uncited (the vendors' pages
 * were unreachable when this was written; see the PR's Sources). Commit messages are not kept.
 */
export async function readDeploys(
  config: ChangesConfig["deploys"],
  env: Env,
  fetcher: Fetcher,
): Promise<SourceRead<Deploy>> {
  if (!config) return { state: "not-configured" };
  const vercel = config.provider === "vercel";
  const tokenVar = vercel ? VERCEL_TOKEN : NETLIFY_TOKEN;
  const token = text(env[tokenVar]);
  const name = vercel ? "Vercel" : "Netlify";
  if (!token)
    return {
      state: "could-not-check",
      reason: `${tokenVar} is not set, so ${name}'s deployments were not asked`,
    };
  const access: ProviderAccess = {
    provider: name,
    env,
    secretVars: [tokenVar],
    fetcher,
    authorization: `Bearer ${token}`,
  };
  const url = vercel
    ? `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(config.projectId)}&target=production&limit=${DEPLOYS_MAX}${config.teamId ? `&teamId=${encodeURIComponent(config.teamId)}` : ""}`
    : `https://api.netlify.com/api/v1/sites/${encodeURIComponent((config as { siteId: string }).siteId)}/deploys?per_page=${DEPLOYS_MAX}`;
  const got = await getProviderJson(access, url, "the deployments");
  if (!got.ok) return { state: "could-not-check", reason: got.reason };
  const rows = vercel ? (isRecord(got.body) ? got.body.deployments : undefined) : got.body;
  if (!Array.isArray(rows))
    return {
      state: "could-not-check",
      reason: `${name} answered with something that is not a list of deployments`,
    };
  const items: Deploy[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    if (!vercel && text(r.context) !== undefined && r.context !== "production") continue;
    const id = text(vercel ? r.uid : r.id);
    const createdAt = iso(vercel ? r.created : r.created_at);
    const commit = vercel
      ? text(isRecord(r.meta) ? r.meta.githubCommitSha : undefined)
      : text(r.commit_ref);
    if (id && createdAt) items.push({ id, createdAt, ...(commit ? { commit } : {}) });
  }
  return { state: "read", items };
}
