/**
 * Remove anything that looks like a secret before text leaves core (findings, reports, errors).
 * Rules are plain patterns, so the same text always redacts the same way.
 */
const RULES: ReadonlyArray<[RegExp, string]> = [
  // Stripe secret, restricted and webhook keys
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, "$1_$2_[redacted]"],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, "whsec_[redacted]"],
  // AWS access key ids
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1[redacted]"],
  // GitHub tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh_[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[redacted]"],
  // Slack tokens
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "xox-[redacted]"],
  // Resend and generic "re_" API keys
  [/\bre_[A-Za-z0-9]{16,}\b/g, "re_[redacted]"],
  // Sanity tokens
  [/\bsk[A-Za-z0-9]{60,}\b/g, "sk[redacted]"],
  // Google API keys
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza[redacted]"],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]"],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // Secret-looking query parameters
  [
    /([?&](?:token|access_token|api_key|apikey|key|secret|password|sig|signature|auth)=)[^&#\s"']+/gi,
    "$1[redacted]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
