import { clip } from "../handoff/http.js";
import { ConfigError } from "../errors.js";
import { attribute, type Attribution } from "./attribute.js";
import { diffRecords } from "./record.js";
import { inOrder, newFindings, type Since } from "./history.js";
import type {
  ChangeLabel,
  Deploy,
  FieldChange,
  RecordedFinding,
  Revision,
  RunRecord,
  SourceRead,
} from "./types.js";

export interface Warranty {
  /** YYYY-MM-DD, the last day inside the warranty. */
  ends: string;
  covers?: string | undefined;
}

/** What the attribution can read. Both are reads: a revision list for one document, the deploys of the site. */
export interface ChangeSources {
  revisions(path: string, since: string): Promise<SourceRead<Revision>>;
  /** The deployments, covering at least from `since` (the earliest earlier run asked about). */
  deploys(since: string): Promise<SourceRead<Deploy>>;
}

export interface ChangeItem {
  finding: RecordedFinding;
  firstSeen: { runId: string; at: string };
  /** The run it is compared with; absent when there is no earlier run of the page. */
  previous?: { runId: string; at: string };
  /** What differs on the page, when both runs have it. */
  fields: FieldChange[];
  label: ChangeLabel;
  attribution: Attribution;
  /** The finding is older than the history kept: "changed before <date>, history not kept". */
  historyNotKept?: string;
  /** A source that was not read, so the label rules nothing out about it. */
  notChecked: string[];
  /** The factual sentence, the same whichever side the evidence points to. */
  sentence: string;
  /** "inside the warranty period" or "after the warranty period"; never a price. */
  warranty?: string;
}

export interface ChangesReport {
  site: string;
  runs: number;
  items: ChangeItem[];
  /** Findings with no earlier run to compare with: named, not listed. */
  noHistory: number;
  /** Findings on pages the latest run did not read (not compared): how many. */
  offPage: number;
  /** What `since` meant, for "No new findings since ...". */
  since: string;
  /** Set when the question cannot be answered from what is stored (a date newer than every run). */
  note?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct 2026" from an ISO time, in UTC. */
export function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const names = (revs: Revision[]): string => {
  const who = [...new Set(revs.map((r) => clip(r.editor ?? "an editor", 80)))];
  return who.length > 1
    ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`
    : (who[0] ?? "an editor");
};

/** The one-sentence evidence. Wording is fixed: it says what the records show and never who is at fault. */
export function describe(a: Attribution, path: string): string {
  const edit = () => {
    const last = a.revisions.at(-1)!;
    const docs = [...new Set(a.revisions.map((r) => clip(r.documentId, 80)))].join(", ");
    return `a content edit on ${day(last.time)} by ${names(a.revisions)} (document ${docs})`;
  };
  const deploy = () => {
    const ids = a.deploys.map((d) => clip(d.id, 80)).join(", ");
    return `a deploy on ${day(a.deploys.at(-1)!.createdAt)} (${a.deploys.length > 1 ? "deploys" : "deploy"} ${ids}${a.commitRange ? `, commits ${a.commitRange}` : ""})`;
  };
  switch (a.label) {
    case "content-edit":
      return `Changed by ${edit()}.`;
    case "code-deploy":
      return `Changed with ${deploy()}${a.notChecked.length === 0 ? `; no content edit of ${clip(path, 120)} is recorded in that time` : ""}.`;
    case "both":
      return `Both ${edit()} and ${deploy()} fall between the two runs, so the records do not show which one changed it.`;
    case "unknown":
      return `Gaugeline cannot tell what changed it: ${a.reasons.join("; ")}.`;
  }
}

/** The client-ready line. Dates only; there is no price anywhere in it. */
export function warrantyNote(w: Warranty, changedAt: string): string {
  const inside = changedAt.slice(0, 10) <= w.ends;
  const covers = w.covers ? ` (covers: ${w.covers})` : "";
  const ends = day(`${w.ends}T00:00:00Z`);
  return inside
    ? `This appeared inside the warranty period (it ends ${ends})${covers}.`
    : `This appeared after the warranty period (it ended ${ends})${covers}.`;
}

/** Findings new since `since`, each with what changed on its page and what the records say about why. */
export async function buildChanges(args: {
  site: string;
  runs: readonly RunRecord[];
  since?: Since;
  sources: ChangeSources;
  warranty?: Warranty | undefined;
  /** When runs were pruned, the date history is kept from. */
  prunedBefore?: string | undefined;
}): Promise<ChangesReport> {
  const ordered = inOrder(args.runs);
  const latest = ordered.at(-1);
  const since = args.since ?? { kind: "previous" as const };
  // A point in history that is not there is an error, never "nothing new".
  if (since.kind === "run" && !ordered.some((r) => r.id === since.id))
    throw new ConfigError(
      `run ${since.id} is not stored; ${ordered[0] ? `history kept from ${day(ordered[0].takenAt)}` : "no runs are stored for this site"}.`,
      { hint: "Use a run id from gaugeline changes --json, or a date." },
    );
  const sinceText =
    since.kind === "previous" ? "the run before" : since.kind === "date" ? day(since.at) : since.id;
  const base = {
    site: args.site,
    runs: ordered.length,
    offPage: latest?.offPage ?? 0,
    since: sinceText,
  };
  if (latest && since.kind === "date" && latest.takenAt < since.at)
    return {
      ...base,
      items: [],
      noHistory: 0,
      note: `The latest stored run is from ${day(latest.takenAt)}, which is before ${day(since.at)}, so there is nothing to compare.`,
    };
  const appearances = newFindings(ordered, since);
  const earliest = appearances
    .flatMap((a) => (a.before ? [a.before.takenAt] : []))
    .reduce<string | undefined>((a, b) => (a === undefined || b < a ? b : a), undefined);
  const deploys: SourceRead<Deploy> =
    earliest === undefined ? { state: "not-configured" } : await args.sources.deploys(earliest);
  const items: ChangeItem[] = [];
  let noHistory = 0;
  for (const { finding, first, before } of appearances) {
    const now = first.pages[finding.path];
    if (!before || !now) {
      // The earliest run kept has it: either the page was never read before, or the runs before were pruned.
      if (args.prunedBefore !== undefined && before === undefined) {
        const reason = `changed before ${day(args.prunedBefore)}, history not kept`;
        items.push({
          finding,
          firstSeen: { runId: first.id, at: first.takenAt },
          fields: [],
          label: "unknown",
          attribution: {
            label: "unknown",
            revisions: [],
            deploys: [],
            reasons: [reason],
            notChecked: [],
          },
          notChecked: [],
          historyNotKept: args.prunedBefore,
          sentence: `Changed before ${day(args.prunedBefore)}, history not kept.`,
        });
      } else noHistory++;
      continue;
    }
    const prev = before.pages[finding.path]!;
    const revisions = await args.sources.revisions(finding.path, before.takenAt);
    const attribution = attribute({
      after: before.takenAt,
      upTo: first.takenAt,
      revisions,
      deploys,
    });
    items.push({
      finding,
      firstSeen: { runId: first.id, at: first.takenAt },
      previous: { runId: before.id, at: before.takenAt },
      fields: diffRecords(prev, now),
      label: attribution.label,
      attribution,
      notChecked: attribution.notChecked,
      sentence: describe(attribution, finding.path),
      ...(args.warranty ? { warranty: warrantyNote(args.warranty, first.takenAt) } : {}),
    });
  }
  return { ...base, items, noHistory };
}

/** The terminal text: one block per finding. Anything from a page or a collaborator is escaped. */
export function formatChanges(report: ChangesReport): string {
  if (report.runs === 0)
    return "No runs are stored for this site yet. Run it with --since last first.\n";
  const lines: string[] = [];
  if (report.note) lines.push(report.note);
  else if (report.items.length === 0)
    lines.push(
      report.noHistory > 0
        ? `${report.noHistory} new finding${report.noHistory === 1 ? "" : "s"} with no earlier run of the page to compare with.`
        : `No new findings since ${report.since}.`,
    );
  for (const it of report.items) {
    lines.push(
      `${clip(it.finding.checkId, 100)} on ${clip(it.finding.path, 200)}: ${clip(it.finding.title, 200)}`,
    );
    if (it.previous)
      lines.push(`  What changed on the page (${day(it.previous.at)} to ${day(it.firstSeen.at)}):`);
    if (it.fields.length === 0 && it.previous)
      lines.push("    nothing in the fields Gaugeline keeps");
    for (const f of it.fields) lines.push(`    ${clip(f.detail, 400)}`);
    lines.push(`  ${it.label}: ${clip(it.sentence, 600)}`);
    for (const n of it.notChecked) lines.push(`  Not checked: ${clip(n, 300)}.`);
    if (it.warranty) lines.push(`  ${clip(it.warranty, 400)}`);
    lines.push("");
  }
  if (report.items.length > 0 && report.noHistory > 0)
    lines.push(`${report.noHistory} more with no earlier run of the page to compare with.`);
  if (report.offPage > 0)
    lines.push(
      `${report.offPage} finding${report.offPage === 1 ? "" : "s"} on other pages ${report.offPage === 1 ? "is" : "are"} not compared: run Gaugeline on those pages with --since last.`,
    );
  return `${lines.join("\n").trimEnd()}\n`;
}
