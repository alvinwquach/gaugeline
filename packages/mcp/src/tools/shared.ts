import * as z from "zod";
import { GaugelineError } from "@gaugeline/core";
import { findingForAgent, markUntrusted, type FindingForAgent } from "../agent-text.js";
import { ToolError, type StoredRun } from "../state.js";

/** A full http or https address. file://, ftp:// and the rest are refused before anything is read. */
export const urlSchema = z
  .string()
  .max(2048)
  .refine((v) => /^https?:\/\/[^\s/]/i.test(v) && URL.canParse(v), {
    message: "Give a full http or https address, for example https://harbourline.example/.",
  });

/** The most findings one result carries; the rest are counted and stay in the run for explain_finding. */
export function findingsForAgent(run: StoredRun, max: number, findings = run.findings) {
  const shown: FindingForAgent[] = findings
    .slice(0, max)
    .map((f) => findingForAgent(f, run.registry));
  const omitted = Math.max(0, findings.length - max);
  return {
    findings: shown,
    ...(omitted > 0
      ? {
          omitted,
          omittedNote: `${omitted} more finding${omitted === 1 ? "" : "s"} in ${run.id}, lowest severity last: narrow the run with checks, or explain a finding by id.`,
        }
      : {}),
  };
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;

/**
 * Text from a refusal or an error, made safe for the model: no address a name resolved to (a private or
 * link-local address is never reported), and what is left is labelled as text from outside, because a
 * host name, a redirect target or a plan cell in it was chosen by someone else.
 */
export function labelDetail(
  text: string,
  source = "could-not-check reason",
  maxChars = 200,
  keep: readonly string[] = [],
) {
  // The operator's own configured addresses stay readable; every other address is withheld.
  const kept = keep.filter((k) => k !== "");
  let work = text;
  // Whole address tokens only: base http://10.0.0.5 must not keep the start of 10.0.0.50.
  kept.forEach((k, i) => {
    const token = new RegExp(
      `(?<![\\w.:-])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`,
      "g",
    );
    work = work.replace(token, `\u0001${i}\u0001`);
  });
  work = work.replace(IPV4, "[address withheld]").replace(IPV6, "[address withheld]");
  kept.forEach((k, i) => (work = work.split(`\u0001${i}\u0001`).join(k)));
  return markUntrusted(work, { source, maxChars });
}

/** At most this many could-not-check entries are returned; the count says how many more there are. */
export const MAX_COULD_NOT_CHECK = 20;

export function couldNotCheckForAgent(
  list: readonly { id: string; reason: string; line?: number }[],
) {
  const shown = list.slice(0, MAX_COULD_NOT_CHECK).map((c) => ({
    id: c.id,
    ...(c.line !== undefined ? { line: c.line } : {}),
    reason: labelDetail(c.reason),
  }));
  const omitted = Math.max(0, list.length - shown.length);
  return {
    couldNotCheck: shown,
    ...(omitted > 0
      ? {
          couldNotCheckOmitted: omitted,
          couldNotCheckNote: `${omitted} more checks could not read what they needed, for the same kinds of reason; the first ${shown.length} are listed.`,
        }
      : {}),
  };
}

/**
 * A failed call as the model sees it. Our own messages (ToolError) are fixed text. A core error is never
 * passed on raw: its message may carry a host a redirect named, a resolved address or a plan cell, so it
 * becomes a fixed sentence plus a labelled, address-free detail.
 */
export function asToolError(err: unknown, keep: readonly string[] = []): Error {
  if (err instanceof ToolError) return err;
  if (err instanceof GaugelineError)
    return new ToolError(
      JSON.stringify({
        error: "Gaugeline could not complete this request.",
        code: err.code,
        detail: labelDetail(err.message, "error detail", 300, keep),
      }),
    );
  return new ToolError("The tool failed unexpectedly. Nothing was changed.");
}
