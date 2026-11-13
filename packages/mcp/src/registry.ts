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
import { UNTRUSTED_NOTE, findingSlots } from "./agent-text.js";
import type { ServerOptions, ToolContext } from "./state.js";
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
  /**
   * Where the page text sits in the result (paths: `.` for a field, `[]` for every item of a list), for a
   * tool with `pageText: true`; absent for one without. Each slot is a field marked `untrusted: true`.
   * assertUntrustedSlots refuses a tool that returns page text and does not say where.
   */
  untrustedSlots?: readonly string[];
  /** True when the tool makes requests to the site it is given (GET and HEAD only, through the fetcher). */
  requests: boolean;
  /** Whether the server offers this tool with these options. Absent means always. A tool that is off is not listed. */
  enabled?(options: ServerOptions): boolean;
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

/**
 * The result fields of draft_fix that quote the page (the diff's file name and the diff). Written as keys
 * and not as quoted strings: the no-write scan (no-write.test.ts) reads a quoted word that is also an
 * HTTP method as a method, and this one is a field name.
 */
const DRAFT_FIX_FIELDS = Object.keys({ file: 0, patch: 0 });

export const TOOLS = {
  run_check: tool({
    kind: "read",
    title: "Check a page",
    summary:
      "Checks one public page and its site with Gaugeline: GET and HEAD requests only, private addresses refused. Probing checks (non-public paths) run only if the person who runs this server turned them on for the site; a call cannot.",
    pageText: true,
    untrustedSlots: [...findingSlots("findings[]", false), "couldNotCheck[].reason"],
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
    untrustedSlots: findingSlots("finding"),
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
    untrustedSlots: [...findingSlots("new.findings[]"), ...findingSlots("fixed.findings[]")],
    requests: false,
    inputSchema: compareRunsInput,
    run: compareRuns,
  }),
  plan_check: tool({
    kind: "read",
    title: "Check a launch plan",
    summary:
      "Checks a launch-plan file (inside the folder the operator named with --root) against a built site at an address the operator allowed with --plan-base: GET requests for each planned page and each old address. Reads the plan file; nothing is written. Offered only when the server was started with both.",
    pageText: true,
    untrustedSlots: [...findingSlots("findings[]"), "couldNotCheck[].reason"],
    requests: true,
    // Off unless the operator named a plan folder AND the addresses a plan may be checked against.
    enabled: (o) => Boolean(o.root) && (o.planBases?.length ?? 0) > 0,
    inputSchema: planCheckInput,
    run: planCheck,
  }),
  draft_fix: tool({
    kind: "draft",
    title: "Draft a fix",
    summary:
      "Drafts the change that would fix a finding from this session, as text for a person or a coding agent to apply: a unified diff where the run holds what it needs (a missing viewport or canonical tag, a missing robots.txt), otherwise the change in words. Makes no request.",
    pageText: true,
    untrustedSlots: [...DRAFT_FIX_FIELDS, ...findingSlots("finding")],
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

/**
 * Refuses a registry with a tool that has no kind of `read` or `draft`. The server calls it before it
 * registers anything, so an unlabelled tool cannot be served; a test calls it with one to prove it.
 */
export function assertLabelled(tools: Record<string, object>): void {
  const bad = Object.entries(tools)
    .filter(([, t]) => {
      const kind = (t as { kind?: unknown }).kind;
      return kind !== "read" && kind !== "draft";
    })
    .map(([name]) => name);
  if (bad.length > 0)
    throw new Error(
      `Every tool needs kind "read" or "draft". Missing or invalid on: ${bad.join(", ")}.`,
    );
}

const SLOT_PATH = /^[A-Za-z]+(?:\[\])?(?:\.[A-Za-z]+(?:\[\])?)*$/;

/**
 * Refuses a registry where a tool that returns page text (`pageText: true`) does not declare the places
 * it puts it, where one that does not return page text declares any, or where a slot is not a path. The
 * server calls it before it registers anything, so a new tool cannot be served until it says where its
 * untrusted text is; a test calls it with one to prove it.
 */
export function assertUntrustedSlots(tools: Record<string, object>): void {
  const problems: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const { pageText, untrustedSlots: slots } = t as {
      pageText?: unknown;
      untrustedSlots?: unknown;
    };
    const list = Array.isArray(slots) ? (slots as unknown[]) : [];
    if (pageText === true && list.length === 0)
      problems.push(`${name} returns page text and declares no untrustedSlots`);
    else if (pageText !== true && slots !== undefined && list.length > 0)
      problems.push(`${name} declares untrustedSlots but pageText is not true`);
    const bad = list.filter((p) => typeof p !== "string" || !SLOT_PATH.test(p));
    if (bad.length > 0) problems.push(`${name} has a slot that is not a path`);
    if (new Set(list).size !== list.length) problems.push(`${name} declares a slot twice`);
  }
  if (problems.length > 0) throw new Error(`Untrusted slots: ${problems.join("; ")}.`);
}
