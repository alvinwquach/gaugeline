import { attribute, type Attribution } from "./attribute.js";
import { diffRecords } from "./record.js";
import { newFindings, type Since } from "./history.js";
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
  deploys(): Promise<SourceRead<Deploy>>;
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
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct 2026" from an ISO time, in UTC. */
export function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const names = (revs: Revision[]): string => {
  const who = [...new Set(revs.map((r) => r.editor ?? "an editor"))];
  return who.length > 1
    ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`
    : (who[0] ?? "an editor");
};

/** The one-sentence evidence. Wording is fixed: it says what the records show and never who is at fault. */
export function describe(a: Attribution, path: string): string {
  const edit = () => {
    const last = a.revisions.at(-1)!;
    const docs = [...new Set(a.revisions.map((r) => r.documentId))].join(", ");
    return `a content edit on ${day(last.time)} by ${names(a.revisions)} (document ${docs})`;
  };
  const deploy = () => {
    const ids = a.deploys.map((d) => d.id).join(", ");
    return `a deploy on ${day(a.deploys.at(-1)!.createdAt)} (${a.deploys.length > 1 ? "deploys" : "deploy"} ${ids}${a.commitRange ? `, commits ${a.commitRange}` : ""})`;
  };
  switch (a.label) {
    case "content-edit":
      return `Changed by ${edit()}.`;
    case "code-deploy":
      return `Changed with ${deploy()}; no content revision of ${path} is recorded in that time.`;
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
  const items: ChangeItem[] = [];
  let noHistory = 0;
  const deploys = await args.sources.deploys();
  for (const { finding, first, before } of newFindings(args.runs, args.since)) {
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
          attribution: { label: "unknown", revisions: [], deploys: [], reasons: [reason] },
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
      sentence: describe(attribution, finding.path),
      ...(args.warranty ? { warranty: warrantyNote(args.warranty, first.takenAt) } : {}),
    });
  }
  return { site: args.site, runs: args.runs.length, items, noHistory };
}

/** The terminal text: one block per finding. */
export function formatChanges(report: ChangesReport): string {
  if (report.runs === 0)
    return "No runs are stored for this site yet. Run it with --since last first.\n";
  const lines: string[] = [];
  if (report.items.length === 0)
    lines.push(
      report.noHistory > 0
        ? `${report.noHistory} new finding${report.noHistory === 1 ? "" : "s"} with no earlier run of the page to compare with.`
        : "No new findings since the run before.",
    );
  for (const it of report.items) {
    lines.push(`${it.finding.checkId} on ${it.finding.path}: ${it.finding.title}`);
    if (it.previous)
      lines.push(`  What changed on the page (${day(it.previous.at)} to ${day(it.firstSeen.at)}):`);
    if (it.fields.length === 0 && it.previous)
      lines.push("    nothing in the fields Gaugeline keeps");
    for (const f of it.fields) lines.push(`    ${f.detail}`);
    lines.push(`  ${it.label}: ${it.sentence}`);
    if (it.warranty) lines.push(`  ${it.warranty}`);
    lines.push("");
  }
  if (report.items.length > 0 && report.noHistory > 0)
    lines.push(`${report.noHistory} more with no earlier run of the page to compare with.`);
  return `${lines.join("\n").trimEnd()}\n`;
}
