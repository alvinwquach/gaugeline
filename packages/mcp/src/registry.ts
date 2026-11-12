/**
 * The ONE registry of tools. Every tool has a kind, and the kind is also the first word of its
 * description, so a client that shows only descriptions still shows it:
 *
 *   read   looks at a site, a plan or this session's runs, and returns data. Changes nothing.
 *   draft  returns text a person or a coding agent can apply. Applies nothing itself.
 *
 * There is no third kind. No tool writes a file, publishes, merges, deploys or changes a site, and
 * none approves anything: assistants plan, people approve. A tool that did would not be added here
 * with a new kind; it would not be added.
 */
import type * as z from "zod";
import { UNTRUSTED_NOTE } from "./agent-text.js";
import type { ToolContext } from "./state.js";
import { compareRuns, compareRunsInput } from "./tools/compare-runs.js";
import { draftFix, draftFixInput } from "./tools/draft-fix.js";
import { explainFinding, explainFindingInput } from "./tools/explain-finding.js";
import { listChecks, listChecksInput } from "./tools/list-checks.js";
import { planCheck, planCheckInput } from "./tools/plan-check.js";
import { runCheck, runCheckInput } from "./tools/run-check.js";

export type ToolKind = "read" | "draft";

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  kind: ToolKind;
  title: string;
  /** What the tool does and reads, in plain words. The kind and the fixed notes are added to it. */
  summary: string;
  /** True when the result carries text taken from a site (then the description repeats the untrusted note). */
  pageText: boolean;
  /** True when the tool makes requests to the site it is given (GET and HEAD only, through the fetcher). */
  requests: boolean;
  inputSchema: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
}

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const KIND_NOTE: Record<ToolKind, string> = {
  read: "Read-only: it changes nothing.",
  draft: "Returns text only: it applies, writes, commits and publishes nothing.",
};

export const TOOLS = {
  run_check: tool({
    kind: "read",
    title: "Check a page",
    summary:
      "Checks one public page and its site with Gaugeline: GET and HEAD requests only, private addresses refused. Probing checks (non-public paths) run only if ownerConsent is true on this call.",
    pageText: true,
    requests: true,
    inputSchema: runCheckInput,
    run: runCheck,
  }),
  list_checks: tool({
    kind: "read",
    title: "List checks",
    summary:
      "Lists the checks Gaugeline runs (id, area, severity, size), optionally for one area or framework. Makes no request.",
    pageText: false,
    requests: false,
    inputSchema: listChecksInput,
    run: listChecks,
  }),
  explain_finding: tool({
    kind: "read",
    title: "Explain a finding",
    summary:
      "Explains a finding from a run in this session, or a check by id: what it catches, why it matters, how to fix it and how big the fix is. Makes no request.",
    pageText: true,
    requests: false,
    inputSchema: explainFindingInput,
    run: explainFinding,
  }),
  compare_runs: tool({
    kind: "read",
    title: "Compare two runs",
    summary:
      "Compares two runs from this session: which findings are new, which are fixed, how many are unchanged. Makes no request.",
    pageText: true,
    requests: false,
    inputSchema: compareRunsInput,
    run: compareRuns,
  }),
  plan_check: tool({
    kind: "read",
    title: "Check a launch plan",
    summary:
      "Checks a launch-plan file (a folder inside the server's root) against a built site: GET requests for each planned page and each old address. Reads the plan file; nothing is written.",
    pageText: true,
    requests: true,
    inputSchema: planCheckInput,
    run: planCheck,
  }),
  draft_fix: tool({
    kind: "draft",
    title: "Draft a fix",
    summary:
      "Drafts the change that would fix a finding from this session, as text for a person or a coding agent to apply. Makes no request.",
    pageText: true,
    requests: false,
    inputSchema: draftFixInput,
    run: draftFix,
  }),
} as const satisfies Record<string, ToolDef>;

export type ToolName = keyof typeof TOOLS;

/** `[read] Checks one page ... Read-only: it changes nothing.` The kind leads, so it is seen first. */
export function describeTool(def: ToolDef): string {
  return [`[${def.kind}]`, def.summary, KIND_NOTE[def.kind], def.pageText ? UNTRUSTED_NOTE : ""]
    .filter(Boolean)
    .join(" ");
}
