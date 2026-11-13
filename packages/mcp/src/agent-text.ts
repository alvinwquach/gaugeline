/**
 * The one place page-derived text is prepared for the model. Every tool that returns a finding goes
 * through `findingForAgent`; no tool builds its own copy of a title, evidence line or address.
 * N17 (packages/core/src/untrusted.ts, exported from @gaugeline/core) owns the escaping; this file only adds the finding's id and
 * the check's own fixed title, which are written by Gaugeline and not by the site.
 */
import {
  UNTRUSTED_FIELD_NOTE,
  fingerprint,
  markUntrusted,
  wrapFindingForAgent,
  type AgentFinding,
  type CheckRegistry,
  type Finding,
} from "@gaugeline/core";

export { markUntrusted };

/** The fixed note every tool that returns page text repeats in its description. */
export const UNTRUSTED_NOTE = UNTRUSTED_FIELD_NOTE;

/** The most plan lines one grouped finding lists; `linesTotal` says how many rows it covers when there are more. */
export const MAX_GROUP_LINES = 50;

/**
 * Where a finding's page text sits, as paths into a result: `.` for a field, `[]` for every item of a
 * list. A tool that returns findings declares these under the name of the place it puts them
 * (`findings[]`, `finding`, `new.findings[]`), so a test, and a reader, can tell the slots from the
 * sentences the server wrote. Only a plan finding has a group key; a page check never sets one.
 */
export const findingSlots = (at: string, group = true): string[] =>
  [...["title", "evidence", "url"], ...(group ? ["group.key"] : [])].map(
    (field) => `${at}.${field}`,
  );

export interface FindingForAgent extends Omit<AgentFinding, "group"> {
  group?: { key: ReturnType<typeof markUntrusted>; lines: number[]; linesTotal?: number };
  /** Stable across runs (the same fingerprint the baseline uses): pass it to explain_finding or draft_fix. */
  id: string;
  /** The check's own title, written by Gaugeline. */
  checkTitle: string;
}

export function findingId(finding: Finding): string {
  return fingerprint(finding);
}

export function findingForAgent(finding: Finding, registry: CheckRegistry): FindingForAgent {
  const { group, ...wrapped } = wrapFindingForAgent(finding);
  return {
    id: findingId(finding),
    checkTitle: registry.get(finding.checkId)?.title ?? finding.checkId,
    ...wrapped,
    // A plan finding's group key is a cell from the plan (a path, a title, a keyword): page-derived text
    // that wrapFindingForAgent leaves as it is, so it is labelled here.
    ...(group
      ? {
          group: {
            key: markUntrusted(group.key, { source: "plan group key" }),
            lines: group.lines.slice(0, MAX_GROUP_LINES),
            ...(group.lines.length > MAX_GROUP_LINES ? { linesTotal: group.lines.length } : {}),
          },
        }
      : {}),
  };
}
