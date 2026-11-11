import { NOTES_FILE, type InitPlan } from "./plan.js";
import type { StackReport } from "./stack.js";

export interface InitOutput {
  report: StackReport;
  plan: InitPlan;
  /** `--dry-run`: nothing was written; every file's text is printed instead. */
  dryRun: boolean;
  /** The paths written, as the writer gave them. Empty with `dryRun`. */
  wrote: readonly string[];
}

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(1, n - s.length));

/** What `gaugeline init` prints: what it saw, the files, the variables, and what to do next. Deterministic. */
export function renderInit(o: InitOutput): string {
  const { report, plan } = o;
  const out: string[] = [`Gaugeline init: ${report.site}`, `Read: ${report.pages.join(", ")}`, ""];
  const rows: [string, string][] = [];
  for (const a of report.adapters) rows.push(["Content system", `${a.name} (${a.evidence})`]);
  if (report.framework)
    rows.push(["Framework", `${report.framework.name} (${report.framework.evidence})`]);
  if (report.hosting) rows.push(["Host", `${report.hosting.name} (${report.hosting.evidence})`]);
  if (report.cdn) rows.push(["CDN", `${report.cdn.name} (${report.cdn.evidence})`]);
  if (report.dns) rows.push(["DNS", `${report.dns.name} (${report.dns.evidence})`]);
  for (const f of report.forms) rows.push(["Form", `${f.name} (${f.evidence})`]);
  for (const p of report.payments) rows.push(["Payment", p.evidence]);
  for (const t of report.analytics) rows.push(["Analytics", `${t.name} (${t.evidence})`]);
  for (const l of report.listings) rows.push(["Listing", `${l.name} (${l.evidence})`]);
  out.push("Detected");
  if (rows.length === 0) out.push("  Nothing it could name from the public pages.");
  for (const [k, v] of rows) out.push(`  ${pad(k, 16)}${v}`);
  for (const n of report.notes) out.push(`  Not read: ${n}`);
  out.push("");

  out.push(o.dryRun ? "Would write (--dry-run: nothing was written)" : "Wrote");
  for (const f of plan.files) {
    if (o.dryRun) out.push(`  ${pad(f.name, 28)}${f.what}`);
    else out.push(`  ${o.wrote.find((w) => w.endsWith(f.name)) ?? f.name}`, `    ${f.what}`);
  }
  out.push("");
  if (o.dryRun) for (const f of plan.files) out.push(`--- ${f.name} ---`, f.text.trimEnd(), "");

  if (plan.envVars.length > 0) {
    out.push(
      "Set these in your own environment (names only: never put a key in a file or a commit)",
    );
    for (const v of plan.envVars) out.push(`  ${pad(v.name, 28)}${v.for}`);
    out.push("");
  }
  out.push(`Next, in order of value (the same list is in ${NOTES_FILE})`);
  plan.next.forEach((n, i) => {
    out.push(`  ${i + 1}. ${n.title}`);
    if (n.command) out.push(`     ${n.command}`);
    out.push(`     ${n.docs}`);
  });
  out.push("");
  return out.join("\n");
}
