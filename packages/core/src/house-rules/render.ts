/**
 * What a person reads and what is written (AG-17). The draft file is the config and nothing else, so renaming
 * a reviewed draft to gaugeline.house.json is the whole of adopting it. The review is plain terminal text: a
 * pure function of the draft (no clock, no network). Every quoted line was cleaned and cut when the draft was
 * made, and no line of the rules file reaches the draft file.
 */
import type { HouseRulesDraft, RefusalCode } from "./schema.js";
import { HOUSE_CONFIG_FILE } from "./schema.js";

const WHY: Readonly<Record<RefusalCode, string>> = {
  "unsafe-pattern": "looks like a pattern, not a plain word",
  "absolute-path": "names a file path",
  "not-plain-text": "has characters a plain word, label or number does not",
  "too-many-terms": "names more words than a file may hold",
  "hidden-characters": "has hidden or control characters",
  "too-long": "is longer than 300 characters",
  conflict: "disagrees with an earlier line, which stands",
};
const num = (line: string): string => line.replace(/^line-/u, "line ");

/** The draft file's text: the config as JSON, two-space indent, one newline at the end. */
export function renderHouseDraftJson(draft: HouseRulesDraft): string {
  return `${JSON.stringify(draft.config, null, 2)}\n`;
}

/**
 * The review sheet. `draftFile` is the name the draft was written to, or null when no file was written.
 * It always says that nothing live was changed.
 */
export function renderHouseRulesReview(
  draft: HouseRulesDraft,
  opts: { draftFile: string | null },
): string {
  const out = [`House rules draft: ${draft.summary}`];
  const more = (n: number) => (n > 0 ? [`  and ${n} more`] : []);
  if (draft.understood.length > 0) {
    out.push("", "Understood");
    for (const u of draft.understood) out.push(`  ${num(u.line)}  ${u.says}`);
    out.push(...more(draft.omitted.understood));
  }
  if (draft.notUnderstood.length > 0) {
    out.push("", "Not understood (nothing was guessed: reword the line, or add the rule by hand)");
    for (const n of draft.notUnderstood)
      out.push(
        `  ${num(n.line)}  ${n.text}${n.aimedAtAssistant ? "  [addressed to an assistant: ignored]" : ""}`,
      );
    out.push(...more(draft.omitted.notUnderstood));
  }
  if (draft.refused.length > 0) {
    out.push(
      "",
      "Refused (the line has the shape of a rule, but what it names is not safe to compile)",
    );
    for (const r of draft.refused) out.push(`  ${num(r.line)}  ${r.text}  [${WHY[r.code]}]`);
    out.push(...more(draft.omitted.refused));
  }
  out.push("");
  if (draft.totals.understood === 0)
    out.push(`Nothing was understood, so no draft was written. Nothing live was changed.`);
  else if (opts.draftFile === null) out.push("No file was written. Nothing live was changed.");
  else
    out.push(
      `Draft written to ${opts.draftFile}. Nothing live was changed.`,
      `To adopt it, read it, then rename it to ${HOUSE_CONFIG_FILE}. This command never writes that file.`,
    );
  return `${out.join("\n")}\n`;
}
