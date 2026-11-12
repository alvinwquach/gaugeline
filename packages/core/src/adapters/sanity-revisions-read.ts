import { isRecord } from "../connectors/get-json.js";
import { SANITY_TOKEN, sanitySettings } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { clip, getProviderJson, getProviderText, type ProviderAccess } from "../handoff/http.js";
import type { Revision } from "../changes/types.js";
import { AdapterCouldNotCheck } from "./types.js";

/** Versions are the dates they were fixed. Uncited: the page was unreachable when this was written (see the PR's Sources). */
const HISTORY_VERSION = "v2021-06-07";
const PROJECTS_API = `https://api.sanity.io/${HISTORY_VERSION}`;
/** Transactions read for one document in one question. */
const MAX_TRANSACTIONS = 100;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * Who edited a document since a time, from Sanity's history API: two GETs, one for the document's
 * transactions (newline-delimited JSON: time, author id) and one for the authors' display names. A
 * name Sanity does not give stays absent (the report says "an editor"); an address is never read into
 * the answer. The history API needs a token that can read the project, so a public dataset with no
 * token is could-not-check, with the reason.
 */
export async function readSanityRevisions(
  env: Env,
  fetcher: Fetcher,
  documentId: string,
  since: string,
): Promise<Revision[]> {
  let s;
  try {
    s = sanitySettings(env);
  } catch (err) {
    throw new AdapterCouldNotCheck(err instanceof Error ? err.message : String(err));
  }
  if (s.token === undefined)
    throw new AdapterCouldNotCheck(
      `Sanity's history needs a token: ${SANITY_TOKEN} is not set, so who edited ${documentId} was not asked.`,
    );
  const access: ProviderAccess = {
    provider: "Sanity",
    env,
    secretVars: [SANITY_TOKEN],
    fetcher,
    authorization: `Bearer ${s.token}`,
  };
  const url = `https://${s.projectId}.api.sanity.io/${HISTORY_VERSION}/data/history/${encodeURIComponent(s.dataset)}/transactions/${encodeURIComponent(documentId)}?fromTime=${encodeURIComponent(since)}&excludeContent=true&limit=${MAX_TRANSACTIONS}`;
  const got = await getProviderText(access, url, `the history of ${documentId}`);
  if (!got.ok) throw new AdapterCouldNotCheck(`Sanity history: ${got.reason}`);
  const rows: { time: string; author: string | undefined }[] = [];
  const lines = got.body.split("\n").filter((l) => l.trim() !== "");
  // A full page may be a cut-off list: fail safe instead of reading it as the whole story.
  if (lines.length >= MAX_TRANSACTIONS)
    throw new AdapterCouldNotCheck(
      `Sanity has more than ${MAX_TRANSACTIONS} transactions for ${clip(documentId, 80)} since ${since.slice(0, 10)}, so the window may be missing records`,
    );
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new AdapterCouldNotCheck(
        "Sanity history answered with something that is not a list of transactions.",
      );
    }
    const at = isRecord(row) ? text(row.timestamp) : undefined;
    if (!isRecord(row) || at === undefined || Number.isNaN(Date.parse(at)))
      throw new AdapterCouldNotCheck(
        "Sanity history answered with a transaction that has no time.",
      );
    rows.push({ time: new Date(at).toISOString(), author: text(row.author) });
  }
  const ids = [...new Set(rows.flatMap((r) => (r.author ? [r.author] : [])))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const users = await getProviderJson(
      access,
      `${PROJECTS_API}/projects/${encodeURIComponent(s.projectId)}/users/${ids.map(encodeURIComponent).join(",")}`,
      "the editors' names",
    );
    if (users.ok && Array.isArray(users.body))
      for (const u of users.body)
        if (isRecord(u) && text(u.id) && text(u.displayName))
          names.set(text(u.id) as string, clip(text(u.displayName) as string, 80));
  }
  return rows.map((r) => {
    const editor = r.author ? names.get(r.author) : undefined;
    return {
      documentId: clip(documentId, 80),
      time: r.time,
      ...(editor !== undefined ? { editor } : {}),
    };
  });
}
