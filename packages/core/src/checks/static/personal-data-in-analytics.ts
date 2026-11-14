import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { callsOf, personalIn } from "./personal.js";
import { lineOf, notReadReason, scrub, sortFindings, sourcePathsOf } from "./scan.js";

/**
 * FF-21: a visitor's email, phone number or form values handed to analytics. A call to `dataLayer.push`,
 * `gtag`, a pixel or an analytics client (the table below) whose arguments hold a personal field
 * (an `email` key or variable, `values.phone`, `formData.get("email")`) or, in a file that handles a
 * form, the whole form. A value that is a literal, or is hashed or masked in the same expression, is
 * not found. The finding names the file, the line, the call and the field's name; never a value.
 *
 * // [GC] no source found (uncited): that sending these values to an analytics vendor shares personal data with a third party is a privacy claim, and no page was read that says so for these vendors.
 */
const ID = "personal-data-in-analytics";

const CALLEE =
  /(?<![\w$.])(?:window\s*\.\s*)?(?:dataLayer\s*\??\.\s*push|_paq\s*\??\.\s*push|gtag|fbq|ttq\s*\??\.\s*\w+|plausible|umami\s*\??\.\s*\w+|(?:posthog|mixpanel|amplitude|analytics|segment|heap|va)\s*\??\.\s*\w+|sendGTMEvent|sendGAEvent)\s*\(/g;

export const personalDataInAnalytics = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "No call to analytics is given an email, a phone number or a form's values.",
  estimateChanges:
    "Usually one line per call: send the event name and a non-personal fact instead. If a tag in Tag Manager relies on the personal field, that tag changes too.",
  area: "Security & email",
  severity: "high",
  title: "A visitor's email, phone or form values are sent to analytics",
  what: "A call to the data layer, Google Analytics, a pixel or an analytics client is given a visitor's email, phone number or the values of a form.",
  why: "Analytics and ad tools are run by other companies. An email or a phone number sent to one of them reaches a third party, and a clinic's or a coach's enquiry form can carry health or personal details. It is hard to take back, and it can break the promise in the site's privacy notice.",
  fix: "Send the event and a fact that is not about the person (for example enquiry_sent and the form's name) and leave the field out. If you need it for conversion matching, send it from the server with the visitor's consent, hashed, rather than from the page.",
  tech: "reads the folder's code files (.env files never); a call whose callee is dataLayer.push, _paq.push, gtag, fbq, ttq.*, plausible, umami.*, posthog.*, mixpanel.*, amplitude.*, analytics.*, segment.*, heap.*, va.*, sendGTMEvent or sendGAEvent, and whose arguments hold a personal field name (email, phone, mobile, first_name, last_name, full_name, postcode and the like) as a key with a non-literal value, as a variable or as a member (values.email, formData.get('email')), or, in a file that handles a form, the whole form, is a finding; a value hashed or masked in the same expression is not; the finding is the file, the line, the call and the field's name, never a value; no source file read, or some left out, is could-not-check",
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
