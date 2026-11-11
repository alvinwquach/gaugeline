import { isRecord } from "../connectors/get-json.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { VERCEL_TOKEN_VAR } from "../renewals/tokens.js";
import { clip, getProviderJson, type ProviderAccess } from "./http.js";
import { vercelRole } from "./roles.js";
import type { RawMember, SourceRead } from "./types.js";

const API = "https://api.vercel.com";
/** One page of members; a team with more is could-not-check, because a part of a list cannot show who is missing. */
const PAGE = 100;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * Who holds a Vercel project, read with the token the freelancer already has (GAUGELINE_VERCEL_TOKEN,
 * the name the renewals command uses). Three GETs at most: the project (whose accountId is the team or
 * the person that owns it), then for a team the team's name and its member list, or for a personal
 * account the token's own user. Vercel has no read-only token type: use one scoped to the team.
 * Endpoint shapes are from Vercel's REST API reference as remembered (the page was unreachable when
 * this was written; see Owner actions).
 */
export async function readVercel(args: {
  env: Env;
  fetcher: Fetcher;
  project?: string | undefined;
  teamId?: string | undefined;
}): Promise<SourceRead> {
  if (!args.project)
    return {
      ok: false,
      reason:
        'no Vercel project is named under "vercel" in gaugeline.handoff.json, so Vercel was not asked',
    };
  const token = text(args.env[VERCEL_TOKEN_VAR]);
  if (!token)
    return { ok: false, reason: `${VERCEL_TOKEN_VAR} is not set, so Vercel was not asked` };
  const access: ProviderAccess = {
    provider: "Vercel",
    env: args.env,
    secretVars: [VERCEL_TOKEN_VAR],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const project = encodeURIComponent(args.project);
  const team = args.teamId ? `?teamId=${encodeURIComponent(args.teamId)}` : "";
  const proj = await getProviderJson(
    access,
    `${API}/v9/projects/${project}${team}`,
    `the project ${args.project}`,
  );
  if (!proj.ok) return proj;
  const accountId = isRecord(proj.body) ? text(proj.body.accountId) : undefined;
  if (!accountId)
    return {
      ok: false,
      reason: `Vercel did not say which account owns the project ${args.project}`,
    };
  const subject = clip(isRecord(proj.body) ? (text(proj.body.name) ?? args.project) : args.project);

  if (accountId.startsWith("team_")) {
    const info = await getProviderJson(
      access,
      `${API}/v2/teams/${encodeURIComponent(accountId)}`,
      "the team",
    );
    const name = info.ok && isRecord(info.body) ? text(info.body.name) : undefined;
    const list = await getProviderJson(
      access,
      `${API}/v3/teams/${encodeURIComponent(accountId)}/members?limit=${PAGE}`,
      "the team's members",
    );
    if (!list.ok) return list;
    const body = list.body;
    const rows = isRecord(body) && Array.isArray(body.members) ? body.members : undefined;
    if (!rows)
      return {
        ok: false,
        reason: "Vercel answered about the team's members with something Gaugeline cannot read",
      };
    const next = isRecord(body) && isRecord(body.pagination) ? body.pagination.next : null;
    if (next !== null && next !== undefined)
      return {
        ok: false,
        reason: `the team has more than ${PAGE} members, more than Gaugeline reads, so it cannot say who is missing from the list`,
      };
    const members: RawMember[] = rows.filter(isRecord).map((m) => {
      const raw = text(m.role) ?? "";
      const email = text(m.email);
      const id = text(m.uid);
      return {
        ...(email ? { email } : {}),
        ...(id ? { id } : {}),
        role: vercelRole(raw),
        rawRole: clip(raw, 40),
        pending: m.confirmed === false,
      };
    });
    return {
      ok: true,
      subject,
      account: { kind: "team", ...(name ? { name: clip(name) } : {}) },
      members,
      notes: [],
    };
  }

  // A project in a personal account has no members: its owner is the account, which is the token's user.
  const me = await getProviderJson(access, `${API}/v2/user`, "the token's own account");
  if (!me.ok) return me;
  const user = isRecord(me.body) && isRecord(me.body.user) ? me.body.user : undefined;
  if (!user || text(user.id) !== accountId)
    return {
      ok: false,
      reason: `the token belongs to another account than the personal account that owns ${args.project}, so it cannot say whose it is`,
    };
  const email = text(user.email);
  return {
    ok: true,
    subject,
    account: { kind: "personal" },
    members: [{ ...(email ? { email } : {}), id: accountId, role: "owner", rawRole: "owner" }],
    notes: ["A personal account has no member list: it is one person's login."],
  };
}
