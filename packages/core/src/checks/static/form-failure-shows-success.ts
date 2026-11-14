import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  lineOf,
  matching,
  matchingBack,
  notReadReason,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-20: a form handler that reports success when the send failed. A `try` block that sends (an email
 * library, `.send(`, or a POST with `fetch`) whose `catch` block returns or shows success (`ok: true`,
 * `success: true`, a redirect to a thank-you page, `setSent(true)`) and nothing that says it failed
 * (a throw, `ok: false`, an `error` value, a 4xx or 5xx status). The catch block is read as text; the
 * check runs nothing and never submits a form (CLAUDE.md rule 14).
 *
 * Not covered, and said so in the docs: a `fetch` whose answer is never checked for `res.ok` (it does
 * not throw on a 4xx or 5xx), and a failure handled somewhere the catch block does not show.
 *
 * // [GC] no source found (uncited): that the visitor is shown success and the lead is lost is the consequence of the code pattern, not a documented framework behaviour.
 */
const ID = "form-failure-shows-success";

const SEND =
  /\.\s*send\s*\(|\bsendMail\s*\(|\bsendEmail\s*\(|\bemails\s*\.\s*send\b|\bfetch\s*\(|\baxios\s*\.\s*post\s*\(|\.\s*post\s*\(/;
const POSTS =
  /\bmethod\s*:\s*["'](?:POST|PUT)["']|\.\s*post\s*\(|\.\s*send\s*\(|\bsendMail|\bsendEmail|\bemails\s*\.\s*send/i;
const SUCCESS = [
  /\breturn\s*\{[^}]*\b(?:ok|success|sent|submitted)\s*:\s*true/,
  /\breturn\s*\{[^}]*\bstatus\s*:\s*["'](?:ok|success|sent|submitted)["']/,
  /(?:NextResponse|Response)\s*\.\s*json\s*\(\s*\{[^}]*\b(?:ok|success|sent)\s*:\s*true/,
  /\bredirect\s*\(\s*["'`][^"'`]*(?:thank|success|sent|confirm)/i,
  /\bset(?:Sent|Submitted|Success|Done)\s*\(\s*true\s*\)/,
  /\bsetStatus\s*\(\s*["'](?:success|sent|ok|done)["']\s*\)/,
];
const FAILURE =
  /\bthrow\b|\b(?:ok|success)\s*:\s*false|\berror\s*:|\bstatus\s*:\s*[45]\d\d|\bsetError\b|\bset(?:Failed|Failure)\b|\bsetStatus\s*\(\s*["'](?:error|failed)|\bnotFound\s*\(|\bredirect\s*\(\s*["'`][^"'`]*(?:error|fail)/i;

export const formFailureShowsSuccess = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "When sending the form's message fails, the visitor is shown an error and the failure is logged without the visitor's details.",
  estimateChanges:
    "The handler change is a few lines. Showing the error in the form and deciding what a visitor should do next (try again, phone the venue) is the real work.",
  area: "Leads",
  severity: "high",
  title: "A form shows 'sent' even when sending the message failed",
  what: "A form handler catches an error from sending the email or the webhook and still returns or shows success.",
  why: "When the send fails, the visitor believes their booking, order or question went through, and nobody receives it. The lead is lost without anyone knowing: the site looks healthy, the inbox is quiet, and the visitor does not call to ask.",
  fix: "In the catch block, return an error the form shows (a message and, for a bar or a clinic, the phone number), set a failing status code, and log the failure without the visitor's details. Only show success after the send's answer was ok.",
  tech: "reads the folder's code files (.env files never); a try block holding a send (.send(, sendMail, sendEmail, emails.send, axios.post, .post( or fetch with method POST) whose catch block returns success (ok, success, sent or submitted true, a status of ok or success, Response.json with ok true, a redirect to a thank-you path, setSent(true) and the like) and has no throw, ok false, error value, 4xx or 5xx status or error state, is a finding; the finding is the file and the line of the catch; a fetch whose answer is never checked is not found; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      const bare = scrub(text, true);
      for (const m of bare.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
        const open = m.index + m[0].length - 1;
        const close = matching(bare, open);
        if (close < 0) continue;
        // The try block is the one that ends right before `catch`.
        let before = m.index - 1;
        while (before >= 0 && /\s/.test(bare[before] ?? "")) before--;
        if (bare[before] !== "}") continue;
        const tryOpen = matchingBack(bare, before);
        if (tryOpen < 0) continue;
        const tried = code.slice(tryOpen, before);
        if (!SEND.test(bare.slice(tryOpen, before)) || !POSTS.test(tried)) continue;
        const caught = code.slice(open, close);
        if (!SUCCESS.some((re) => re.test(caught)) || FAILURE.test(caught)) continue;
        findings.push({
          checkId: ID,
          severity: "high",
          title: this.title,
          evidence: `${file}: the send is in a try block, and its catch block reports success.`,
          url,
          source: { file, line: lineOf(code, m.index) },
        });
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
