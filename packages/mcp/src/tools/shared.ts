import * as z from "zod";
import { GaugelineError } from "@gaugeline/core";
import { findingForAgent, type FindingForAgent } from "../agent-text.js";
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

/** Turn a core error into text the caller can read; anything unexpected is passed on as it is. */
export function asToolError(err: unknown): Error {
  if (err instanceof ToolError) return err;
  if (err instanceof GaugelineError)
    return new ToolError(err.hint ? `${err.message} ${err.hint}` : err.message);
  return err instanceof Error ? err : new Error(String(err));
}
