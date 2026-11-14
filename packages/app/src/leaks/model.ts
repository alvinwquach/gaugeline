import type { Checked, Finding, RequestRow, Result } from "../types";

/**
 * What the Leaks & access view shows, decided here and nowhere else. The view reads this model and
 * never the result, so its types are the whole list of what can reach the screen: type names and
 * counts, masked key values (as the checks emit them), addresses and answers. There is no field for
 * a document, a script's text or a full key.
 */

export const DATASET_CHECKS = ["dataset-public", "dataset-private-types"] as const;
export const SCRIPT_CHECKS = ["secret-in-js"] as const;
export const STAGING_CHECKS = [
  "temp-host-links",
  "temp-host-canonical",
  "staging-indexable",
] as const;

/** The published limit of JavaScript files scanned, used when the result does not say. */
export const SCRIPT_LIMIT = 15;

/** Characters of a key that may be shown: the first 6, an ellipsis, the last 2. */
const MASK_CHARS = 9;
const ELLIPSIS = String.fromCharCode(0x2026);

/** Whether a check ran, or why it did not. A check that did not run is never shown as a pass. */
export type Availability = { ran: true } | { ran: false; reason: string };

export interface DatasetPanel {
  projectId: string;
  dataset: string;
  visibility: "public" | "private" | "unknown";
  /** Public only: how many documents there are. */
  documentCount: number | null;
  /** Public only: the type names. */
  types: string[];
  /** Places in the result of the findings about this dataset. */
  findings: number[];
}

export interface KeyEntry {
  /** What kind of key, in the words of the finding ("Stripe secret key"). */
  kind: string;
  /** The first 6 and last 2 characters, as the check emitted them. */
  masked: string;
  /** Place in the result of the finding. */
  finding: number;
}

export interface ScriptRow {
  /** A path on the site, or the whole address of a file elsewhere; "inline script 2 on /checkout" for inline code. */
  address: string;
  state: "scanned" | "partial" | "not-scanned";
  note?: string;
  keys: KeyEntry[];
}

export interface StagingRow {
  address: string;
  kind: "preview-link" | "staging-host" | "this-page";
  /** Whether it answers publicly: unknown when Gaugeline did not ask it. */
  reachable: "yes" | "no" | "unknown";
  answer: string;
  /** Place in the result of the finding about it. */
  finding?: number;
}

export interface LeaksModel {
  /** The server sent the lists these panels are made from (Checked.leaks). */
  kept: boolean;
  dataset: { availability: Availability; datasets: DatasetPanel[] };
  scripts: {
    availability: Availability;
    rows: ScriptRow[];
    /** Files read and scanned, in whole or in part. */
    scanned: number;
    limit: number;
    /** Same-site files on the page beyond the limit. */
    notScanned: number;
  };
  staging: { availability: Availability; rows: StagingRow[]; notes: string[] };
}

type FoundAt = { finding: Finding; index: number };

/** The findings of these checks with their place in the result, which is what Problems links to. */
function findingsOf(result: Result, ids: readonly string[]): FoundAt[] {
  return result.findings.flatMap((finding, index) =>
    ids.includes(finding.checkId) ? [{ finding, index }] : [],
  );
}

function ran(result: Result, id: string): boolean {
  return result.passed.includes(id) || result.findings.some((f) => f.checkId === id);
}

/** Why one check did not run: the reason in the result, else what is known. */
function reasonFor(result: Result, id: string): string {
  const entry = result.couldNotCheck.find((c) => c.id === id);
  if (entry) return entry.reason;
  if (result.failed.includes(id)) return "This check did not finish, so nothing is known.";
  return "This check did not run, so nothing is known.";
}

/** Ran if any of the checks ran; otherwise the first one's reason. */
function availabilityOf(result: Result, ids: readonly string[]): Availability {
  if (ids.some((id) => ran(result, id))) return { ran: true };
  return { ran: false, reason: reasonFor(result, ids[0] ?? "") };
}

/** Never more than the first 6 and last 2 characters, whatever the finding held. */
function limitMask(value: string): string {
  if (value.length <= MASK_CHARS) return value;
  return `${value.slice(0, 6)}${ELLIPSIS}${value.slice(-2)}`;
}

/** "<kind> <masked> in <where> at byte <n>", as secret-in-js words its evidence. */
const KEY_EVIDENCE = /^(.*?) (\S+) in (.+) at byte \d+$/;

function datasetPanels(
  result: Result,
  checked: Checked | undefined,
  availability: Availability,
): DatasetPanel[] {
  const reads = checked?.leaks?.datasets;
  if (!availability.ran || !reads) return [];
  const found = findingsOf(result, DATASET_CHECKS);
  return reads.map((d) => {
    const mine = found
      .filter(({ finding }) =>
        finding.evidence.includes(`project ${d.projectId}, dataset "${d.dataset}"`),
      )
      .map(({ index }) => index);
    const open = d.state === "public";
    return {
      projectId: d.projectId,
      dataset: d.dataset,
      visibility: d.state,
      documentCount: open ? (d.count ?? 0) : null,
      types: open ? [...(d.types ?? [])] : [],
      findings: mine,
    };
  });
}

function scriptState(s: {
  status: number | null;
  truncated: boolean;
}): Pick<ScriptRow, "state" | "note"> {
  if (s.status === null) return { state: "not-scanned", note: "Could not be read (no answer)." };
  if (s.status < 200 || s.status >= 300)
    return { state: "not-scanned", note: `Could not be read (status ${s.status}).` };
  if (s.truncated) return { state: "partial", note: "Only the start of this file was read." };
  return { state: "scanned" };
}

function scriptRows(
  result: Result,
  checked: Checked | undefined,
  availability: Availability,
): ScriptRow[] {
  if (!availability.ran) return [];
  const rows = new Map<string, ScriptRow>();
  for (const s of checked?.leaks?.scripts ?? [])
    if (!rows.has(s.where)) rows.set(s.where, { address: s.where, ...scriptState(s), keys: [] });
  for (const { finding, index } of findingsOf(result, SCRIPT_CHECKS)) {
    const m = KEY_EVIDENCE.exec(finding.evidence);
    const where = m?.[3] ?? finding.evidence;
    // A key in inline code, or in a file the list does not hold, still gets its row.
    const row = rows.get(where) ?? { address: where, state: "scanned" as const, keys: [] };
    rows.set(where, row);
    row.keys.push({
      kind: m?.[1] ?? "Key",
      masked: limitMask(m?.[2] ?? ""),
      finding: index,
    });
  }
  return [...rows.values()];
}

/**
 * The request to staging.<domain>/ that the check made, if the log holds it: a host that starts
 * with "staging." and whose remainder is the page's host or a parent of it.
 */
function stagingRequest(pageUrl: string, requests: readonly RequestRow[]): RequestRow | undefined {
  let page: string;
  try {
    page = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
  return requests.find((r) => {
    try {
      const u = new URL(r.url);
      if (!u.hostname.startsWith("staging.") || u.pathname !== "/" || u.search !== "") return false;
      const rest = u.hostname.slice("staging.".length);
      return page === rest || page.endsWith(`.${rest}`);
    } catch {
      return false;
    }
  });
}

function stagingAnswer(
  status: number | null,
  location: string | undefined,
  indexable: boolean,
): Pick<StagingRow, "reachable" | "answer"> {
  if (status === null) return { reachable: "no", answer: "Does not answer." };
  if (status >= 200 && status < 300)
    return {
      reachable: "yes",
      answer: indexable
        ? "Answers publicly, and does not ask search engines to stay away."
        : "Answers publicly, and asks search engines to stay away.",
    };
  if (status >= 300 && status < 400)
    return {
      reachable: "no",
      answer: location ? `Moves to ${location}.` : "Moves to another address.",
    };
  if (status === 401 || status === 403)
    return { reachable: "no", answer: `Asks for a login (status ${status}).` };
  if (status === 404 || status === 410) return { reachable: "no", answer: "Not found." };
  return { reachable: "no", answer: `Answered with status ${status}.` };
}

function stagingRows(
  result: Result,
  checked: Checked | undefined,
  availability: Availability,
): StagingRow[] {
  if (!availability.ran) return [];
  const rows: StagingRow[] = [];
  const requests = checked?.requests ?? [];

  const [links] = findingsOf(result, ["temp-host-links"]);
  for (const address of checked?.leaks?.previews ?? []) {
    rows.push({
      address,
      kind: "preview-link",
      reachable: "unknown",
      answer: "Linked from the page. Gaugeline did not request it.",
      ...(links ? { finding: links.index } : {}),
    });
  }

  const [canonical] = findingsOf(result, ["temp-host-canonical"]);
  if (canonical)
    rows.push({
      address: checked?.page.url ?? result.url,
      kind: "this-page",
      reachable: "yes",
      answer: "This page is served from a temporary address and names no canonical one.",
      finding: canonical.index,
    });

  const [staging] = findingsOf(result, ["staging-indexable"]);
  const fromFinding = staging
    ? /^(\S+) answers 200/.exec(staging.finding.evidence)?.[1]
    : undefined;
  const asked = stagingRequest(checked?.page.url ?? result.url, requests);
  const address = fromFinding ?? asked?.url;
  if (address && (staging || asked) && ran(result, "staging-indexable"))
    rows.push({
      address,
      kind: "staging-host",
      ...(staging
        ? { reachable: "yes" as const, answer: stagingAnswer(200, undefined, true).answer }
        : stagingAnswer(asked?.status ?? null, asked?.location, false)),
      ...(staging ? { finding: staging.index } : {}),
    });
  return rows;
}

export function toLeaksModel(result: Result, checked?: Checked): LeaksModel {
  const dataset = availabilityOf(result, DATASET_CHECKS);
  const scripts = availabilityOf(result, SCRIPT_CHECKS);
  const staging = availabilityOf(result, STAGING_CHECKS);
  const rows = scriptRows(result, checked, scripts);
  const sample = result.sampled.scripts;
  return {
    kept: checked?.leaks !== undefined,
    dataset: { availability: dataset, datasets: datasetPanels(result, checked, dataset) },
    scripts: {
      availability: scripts,
      rows,
      scanned: (checked?.leaks?.scripts ?? []).filter(
        (s) => s.status !== null && s.status >= 200 && s.status < 300,
      ).length,
      limit: sample?.limit ?? SCRIPT_LIMIT,
      notScanned: sample ? Math.max(0, sample.seen - sample.taken) : 0,
    },
    staging: {
      availability: staging,
      rows: stagingRows(result, checked, staging),
      notes: staging.ran
        ? STAGING_CHECKS.filter((id) => !ran(result, id)).map((id) => reasonFor(result, id))
        : [],
    },
  };
}
