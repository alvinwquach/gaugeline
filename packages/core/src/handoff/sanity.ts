import { isRecord } from "../connectors/get-json.js";
import { SANITY_PROJECT_ID, SANITY_TOKEN } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { clip, getProviderJson, type ProviderAccess } from "./http.js";
import { sanityRole } from "./roles.js";
import type { RawMember, SourceRead } from "./types.js";

/** The projects API (not the content API on <project>.api.sanity.io): the version is the date it was fixed. */
const API = "https://api.sanity.io/v2021-06-07";
const PROJECT_ID = /^[a-z0-9]{4,20}$/;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * Who is in a Sanity project, with the token the freelancer already has (SANITY_TOKEN) and the project
 * id from gaugeline.handoff.json or SANITY_PROJECT_ID. Two GETs: the project (its members, each with a
 * role) and the members' profiles (their addresses). When the second is refused the members are still
 * listed, with no address, and the report says it cannot tell whose they are. A token made for an API
 * integration is a member too: it is marked as a token, not a person. The endpoint shapes are from
 * Sanity's HTTP reference as remembered (the page was unreachable when this was written).
 */
export async function readSanity(args: {
  env: Env;
  fetcher: Fetcher;
  projectId?: string | undefined;
}): Promise<SourceRead> {
  const projectId = args.projectId ?? text(args.env[SANITY_PROJECT_ID]);
  if (!projectId)
    return {
      ok: false,
      reason: `${SANITY_PROJECT_ID} is not set and gaugeline.handoff.json names no Sanity project, so Sanity was not asked`,
    };
  const token = text(args.env[SANITY_TOKEN]);
  if (!token) return { ok: false, reason: `${SANITY_TOKEN} is not set, so Sanity was not asked` };
  if (!PROJECT_ID.test(projectId))
    return {
      ok: false,
      reason: "the Sanity project id is not an id (lower-case letters and digits)",
    };
  const access: ProviderAccess = {
    provider: "Sanity",
    env: args.env,
    secretVars: [SANITY_TOKEN],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const proj = await getProviderJson(
    access,
    `${API}/projects/${projectId}`,
    "the project's members",
  );
  if (!proj.ok) return proj;
  if (!isRecord(proj.body) || !Array.isArray(proj.body.members))
    return {
      ok: false,
      reason: "Sanity answered about the project's members with something Gaugeline cannot read",
    };
  const rows = proj.body.members.filter(isRecord);
  const people = rows
    .filter((m) => m.isRobot !== true)
    .flatMap((m) => (text(m.id) ? [text(m.id) as string] : []));
  const emails = new Map<string, string>();
  const notes: string[] = [];
  if (people.length > 0) {
    const users = await getProviderJson(
      access,
      `${API}/projects/${projectId}/users/${people.map(encodeURIComponent).join(",")}`,
      "the members' addresses",
    );
    if (users.ok && Array.isArray(users.body))
      for (const u of users.body)
        if (isRecord(u) && text(u.id) && text(u.email))
          emails.set(text(u.id) as string, text(u.email) as string);
    if (!users.ok || emails.size < people.length)
      notes.push(
        "Sanity did not show every member's address, so Gaugeline cannot tell whose those accounts are.",
      );
  }
  const members: RawMember[] = rows.map((m) => {
    const id = text(m.id);
    const roles = Array.isArray(m.roles)
      ? m.roles.filter(isRecord).flatMap((r) => (text(r.name) ? [text(r.name) as string] : []))
      : [];
    const raw = text(m.role) ?? roles.join(", ");
    const email = id ? emails.get(id) : undefined;
    return {
      ...(email ? { email } : {}),
      ...(id ? { id } : {}),
      role: sanityRole(text(m.role) ?? roles),
      rawRole: clip(raw, 40),
      ...(m.isRobot === true ? { token: true } : {}),
    };
  });
  const name = text(proj.body.displayName);
  return {
    ok: true,
    subject: clip(name ?? projectId),
    account: { kind: "unknown" },
    members,
    notes,
  };
}
