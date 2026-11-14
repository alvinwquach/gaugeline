/**
 * The names a form gives the field that says where to send the visitor once it is submitted: Salesforce's
 * retURL, WordPress and Laravel's redirect_to, a handler's next or success_url. One list, kept apart from
 * the check so the snapshot can read the same names (it imports nothing, so it cannot form a cycle).
 */
export const REDIRECT_FIELD_NAMES: readonly string[] = Object.freeze([
  "retURL",
  "redirect",
  "redirect_to",
  "redirectUrl",
  "return",
  "returnUrl",
  "return_to",
  "next",
  "_next",
  "thanks",
  "thankyou",
  "success_url",
  "successUrl",
  "goto",
  "destination",
  "continue",
]);

/** A name with case, spaces, hyphens and underscores removed: "Redirect-To" and "redirect_to" are one. */
export const flatName = (name: string): string => name.toLowerCase().replace(/[\s_-]+/g, "");

const FLAT: ReadonlySet<string> = new Set(REDIRECT_FIELD_NAMES.map(flatName));

/** Is this input's name one of the thank-you or redirect names, ignoring case, underscores and hyphens? */
export const isRedirectFieldName = (name: string): boolean => FLAT.has(flatName(name));

/** The longest value the snapshot keeps for one such field, and the most fields it keeps for one form. */
export const REDIRECT_VALUE_MAX = 2048;
export const REDIRECT_FIELDS_MAX = 20;
