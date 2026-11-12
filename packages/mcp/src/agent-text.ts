/**
 * The one place page-derived text is prepared for the model. Every tool that returns a finding goes
 * through `findingForAgent`; no tool builds its own copy of a title, evidence line or address.
 * N17 (packages/core/src/untrusted.ts) owns the escaping; this file only adds the finding's id and
 * the check's own fixed title, which are written by Gaugeline and not by the site.
 */
import { fingerprint, type CheckRegistry, type Finding } from "@gaugeline/core";
// SWAP POINT: when N17 is on main this becomes `import { wrapFindingForAgent } from "@gaugeline/core"`.
import { UNTRUSTED_FIELD_NOTE, wrapFindingForAgent, type AgentFinding } from "./untrusted-stub.js";

/** The fixed note every tool that returns page text repeats in its description. */
export const UNTRUSTED_NOTE = UNTRUSTED_FIELD_NOTE;

export interface FindingForAgent extends AgentFinding {
  /** Stable across runs (the same fingerprint the baseline uses): pass it to explain_finding or draft_fix. */
  id: string;
  /** The check's own title, written by Gaugeline. */
  checkTitle: string;
}

export function findingId(finding: Finding): string {
  return fingerprint(finding);
}

export function findingForAgent(finding: Finding, registry: CheckRegistry): FindingForAgent {
  return {
    id: findingId(finding),
    checkTitle: registry.get(finding.checkId)?.title ?? finding.checkId,
    ...wrapFindingForAgent(finding),
  };
}
