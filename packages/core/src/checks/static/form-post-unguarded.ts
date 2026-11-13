import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { lineOf, notReadReason, scrub, sortFindings, sourcePathsOf } from "./scan.js";

/**
 * FF-23: a public form endpoint with nothing that tells a real submission from a cross-site or
 * automated one. A route handler (`app/**` `route.ts`) that exports POST and reads the submitted body,
 * or a Pages Router API route that does, with none of: a check of the Origin or Referer header, a
 * honeypot field, a signed or captcha token (Turnstile, reCAPTCHA, hCaptcha, a CSRF token, an HMAC or
 * signature check). A Server Action is not looked at: Next compares its Origin with the app's host
 * itself. An endpoint that checks a session, and a webhook receiver, are left alone. When a
 * middleware or proxy file mentions an origin or token check, the finding is could-not-check, since
 * the guard may live there. Static: Gaugeline never submits a form to find out (CLAUDE.md rule 14).
 *
 * // [docs] next@16.4.1 > data-security, "Server Actions" - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx (lines 544-548: Server Actions use POST only and Next compares the Origin header with the host; serverActions.allowedOrigins adds safe origins)
 * // [docs] next@16.4.1 > route.js - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/03-file-conventions/route.mdx (Route Handlers are per-method functions; no origin check is described)
 */
const ID = "form-post-unguarded";

const ROUTE = /(?:^|\/)route\.[cm]?[jt]sx?$/;
const API_ROUTE = /(?:^|\/)pages\/api\/.+\.[cm]?[jt]sx?$/;
const MIDDLEWARE = /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/;
const EXPORTS_POST =
  /\bexport\s+(?:async\s+)?function\s+POST\b|\bexport\s+const\s+POST\b|\bexport\s*\{[^}]*\bPOST\b/;
const READS_BODY = /\.\s*(?:formData|json|text)\s*\(\s*\)|\breq\s*\.\s*body\b/;
/** Paths that are not a form: a signed webhook, a cron job, authentication, a revalidation hook. */
const NOT_A_FORM =
  /(?:^|\/)(?:webhooks?|hooks?|stripe|cron|auth|callback|revalidate|trpc|graphql)(?:\/|$)/i;
const GUARD = [
  /["'](?:origin|referer|referrer)["']|\.\s*(?:origin|referer)\b|\bheaders\s*\.\s*(?:origin|referer)\b/i,
  /honeypot|_gotcha|botcheck|bot-field|hp_?field|["']hp["']/i,
  /turnstile|recaptcha|hcaptcha|captcha|siteverify|csrf|xsrf|nonce|hmac|signature|isValidSignature|constructEvent|timingSafeEqual|\bjwt|jose|altcha/i,
  /getServerSession|\bauth\s*\(|\bgetToken\s*\(|currentUser|requireUser|getSession/,
];

export const formPostUnguarded = defineCheck<LocalSourceInput>({
  id: ID,
  size: "M",
  done: "Every public form endpoint checks the Origin header, a honeypot field or a signed token before it acts on a submission.",
  estimateChanges:
    "A honeypot field and an Origin check are a few lines. A captcha such as Turnstile also needs a key and a change to the form. Moving the endpoint to a Server Action avoids the Origin check by hand.",
  area: "Leads",
  severity: "medium",
  title: "A form endpoint accepts posts with no origin check, honeypot or token",
  what: "A route handler or API route takes a form submission and has no check of where it came from, no honeypot field and no signed or captcha token.",
  why: "Anyone, or any script, can post to the address. The kitchen channel and the inbox fill with spam, a booking list fills with fake dates, and another site can make a visitor's browser post to yours.",
  fix: "Check the Origin header against your own site, add a hidden honeypot field that a person never fills in, and add a captcha or a signed token if spam continues. Or move the form to a Server Action, where Next compares the Origin with the site's host for you.",
  tech: "reads the folder's code files (.env files never); a route.ts handler that exports POST, or a pages/api route, that reads the submitted body and has none of: the Origin or Referer header, a honeypot, a captcha or signed token (Turnstile, reCAPTCHA, hCaptcha, CSRF, nonce, HMAC, signature), a session check, is a finding; paths named webhook, hooks, stripe, cron, auth, callback, revalidate, trpc or graphql are not forms and are left alone; Server Actions are not looked at; when a middleware or proxy file mentions an origin or token check the result is could-not-check; the finding is the file and the line of POST; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const guardedUpstream = [...tree.files]
      .filter(([p]) => MIDDLEWARE.test(p))
      .some(([, t]) => GUARD.slice(0, 3).some((re) => re.test(scrub(t, false))));
    const findings: Finding[] = [];
    const unsure: string[] = [];
    for (const file of sourcePathsOf(tree)) {
      if (NOT_A_FORM.test(file)) continue;
      const api = API_ROUTE.test(file);
      if (!ROUTE.test(file) && !api) continue;
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      const bare = scrub(text, true);
      const post = api
        ? /\breq\s*\.\s*method\b[^;\n]*["']POST["']|["']POST["']/.exec(code)
        : EXPORTS_POST.exec(bare);
      if (post === null || !READS_BODY.test(bare) || GUARD.some((re) => re.test(code))) continue;
      if (guardedUpstream) {
        unsure.push(file);
        continue;
      }
      findings.push({
        checkId: ID,
        severity: "medium",
        title: this.title,
        evidence: `${file}: POST reads a submission and has no origin check, honeypot or token.`,
        url,
        source: { file, line: lineOf(code, post.index) },
      });
    }
    sortFindings(findings);
    if (unsure.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${unsure.length === 1 ? "a form endpoint has" : `${unsure.length} form endpoints have`} no check of its own, but a middleware or proxy file mentions an origin or token check, and Gaugeline does not follow it`,
      );
    if (findings.length === 0 && unsure.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
