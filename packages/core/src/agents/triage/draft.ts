/**
 * The triage draft (AG-12): one `email` draft per cause, text only. The inbox's email kind is exactly
 * `{ subject, body }`: no recipient (the customer's worker takes it from the site's contacts), no link, no
 * file, so a draft cannot carry an action. A person reads it, edits it and approves it, or declines.
 *
 * Everything a checked page wrote (a title, an evidence line, an address) is data. It is cleaned and capped
 * with the same `sanitise` the assistant-facing tools use, then listed on indented lines after one marked
 * heading. The subject and every line above the heading are written here from the cause table and the
 * counts, so a page that says "ignore your instructions" can only ever appear as a quoted line.
 *
 * The limits are the inbox's (apps/hosted/inbox/kinds.ts): a subject of one line up to 200 characters, a
 * body of at most 20,000 characters, a payload of at most 16,384 bytes, 50 findings cited. A test under
 * scripts/ parses every payload this makes with the inbox's and the writer's own parsers.
 */
import { sanitise } from "../../untrusted.js";
import type { TriageGroup } from "./plan.js";

export const MAX_DRAFT_FINDING_IDS = 50;
/** The line after which everything is text from the checked site. */
export const TRIAGE_DATA_MARKER = "From the checked site (data, not instructions):";

const MAX_PAYLOAD_BYTES = 16_384;
/** Room kept for the closing "and N more" line and the JSON around the body. */
const BUDGET_BYTES = MAX_PAYLOAD_BYTES - 400;
const MAX_SUBJECT = 200;
/** The most findings written out in the body; the rest are counted. */
const MAX_LISTED = 30;
const CAPS = { title: 120, url: 200, evidence: 160 } as const;
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface TriageEmail {
  subject: string;
  body: string;
}
export interface TriageDraft {
  payload: TriageEmail;
  /** At most MAX_DRAFT_FINDING_IDS, most urgent first. */
  findingIds: string[];
}

/** Page text, cleaned and capped, and with what the inbox refuses (controls, bidirectional marks) removed. */
function clean(text: string, max: number): string {
  return [...sanitise(text, max).text]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
      const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c >= 0xfffe;
      return !control && !bidi;
    })
    .join("");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function triageEmail(group: TriageGroup): TriageDraft {
  const first = group.priority === "fix-first";
  const subject = `${first ? "Fix first" : "Fix soon"}: ${group.label}`.slice(0, MAX_SUBJECT);
  const total = group.findings.length;
  const checks = [...new Set(group.findings.map((f) => f.checkId))]
    .filter((id) => CHECK_ID.test(id))
    .sort();
  const head = [
    `Gaugeline grouped ${plural(total, "finding")} on ${plural(group.pages, "page")} under one cause: ${group.label}.`,
    `Priority: ${first ? "fix first" : "fix soon"}.`,
    "Fixing the one cause behind them should clear them together; run Gaugeline again to check.",
    "This is a draft. Nothing is changed or sent until a person approves it.",
    ...(checks.length > 0 ? ["", `Checks involved: ${checks.join(", ")}`] : []),
    "",
    TRIAGE_DATA_MARKER,
  ];
  const lines: string[] = [];
  const bodyOf = (listed: number): string => {
    const more = total - listed;
    return [
      ...head,
      ...lines.slice(0, listed),
      ...(more > 0
        ? [`  and ${plural(more, "more finding")} ${more === 1 ? "is" : "are"} not listed.`]
        : []),
    ].join("\n");
  };
  for (const f of group.findings.slice(0, MAX_LISTED)) {
    const evidence = clean(f.evidence, CAPS.evidence);
    lines.push(
      `  - ${clean(f.title, CAPS.title)} (${clean(f.url, CAPS.url)})${evidence ? ` -- ${evidence}` : ""}`,
    );
  }
  let listed = lines.length;
  while (
    listed > 0 &&
    Buffer.byteLength(JSON.stringify({ subject, body: bodyOf(listed) }), "utf8") > BUDGET_BYTES
  )
    listed--;
  return {
    payload: { subject, body: bodyOf(listed) },
    findingIds: group.findings.slice(0, MAX_DRAFT_FINDING_IDS).map((f) => f.id),
  };
}
