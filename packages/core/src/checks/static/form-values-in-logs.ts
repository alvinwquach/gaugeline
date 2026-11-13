import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { callsOf, personalIn } from "./personal.js";
import { lineOf, notReadReason, scrub, sortFindings, sourcePathsOf } from "./scan.js";

/**
 * FF-22: a visitor's email, phone number or form values written to a log or an error report. A call
 * to `console.*`, a logger or an error reporter (Sentry, Bugsnag, Rollbar, Honeybadger) whose arguments
 * hold a personal field or, in a file that handles a form, the whole form (same reading of the
 * arguments as personal-data-in-analytics, personal.ts). The finding names the file, the line, the
 * call and the field's name; never a value.
 *
 * // [GC] no source found (uncited): that logs and error reports keep what they are given, and who can read them, is a property of the log service, and no page was read for it.
 */
const ID = "form-values-in-logs";

const CALLEE =
  /(?<![\w$.])(?:console\s*\??\.\s*(?:log|info|warn|error|debug|trace)|(?:logger|log)\s*\??\.\s*(?:log|info|warn|error|debug|trace|fatal)|(?:Sentry|Bugsnag|Rollbar|Honeybadger)\s*\??\.\s*\w+)\s*\(/g;

export const formValuesInLogs = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "No log line or error report is given an email, a phone number or a form's values.",
  estimateChanges:
    "Usually one line per call. If logs from earlier submissions are kept somewhere, clearing them is a separate job with the host or the log service.",
  area: "Security & email",
  severity: "high",
  title: "A visitor's email, phone or form values are written to a log or an error report",
  what: "A log call or an error report is given a visitor's email, phone number or the values of a form they submitted.",
  why: "Logs and error reports are kept, searched and read by more people than the form's inbox, often for months and by an outside service. An enquiry form for a clinic or a coach can carry health or personal details, and they then sit in a place nobody thought of as holding them.",
  fix: "Log what happened and not who it happened to: the form's name, a status, an id for the submission. For Sentry and similar tools, do not put the form in extra data or set the user's email; turn on the tool's scrubbing of personal data as a second line.",
  tech: "reads the folder's code files (.env files never); a call to console.log, info, warn, error, debug or trace, a logger or log method, or any method of Sentry, Bugsnag, Rollbar or Honeybadger, whose arguments hold a personal field name (email, phone, mobile, first_name, last_name, full_name, postcode and the like) as a key with a non-literal value, as a variable or as a member (values.email, formData.get('email')), or, in a file that handles a form, the whole form, is a finding; a value hashed or masked in the same expression is not; the finding is the file, the line, the call and the field's name, never a value; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      for (const call of callsOf(text, CALLEE)) {
        const field = personalIn(call, text);
        if (field === undefined) continue;
        findings.push({
          checkId: ID,
          severity: "high",
          title: this.title,
          evidence: `${file}: ${call.name} is given ${field === "the whole form" ? field : `the field "${field}"`}.`,
          url,
          source: { file, line: lineOf(code, call.index) },
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
