import { matching, scrub } from "./scan.js";

/**
 * Shared by the two personal-data checks (FF-21: analytics, FF-22: logs and error reports). A call
 * is found by its callee in the scrubbed view; its arguments are read as text to see whether a
 * visitor's email, phone number or form values are being handed over. Names only: the checks say
 * which field name (`email`) went into which call (`dataLayer.push`), never a value.
 */
export interface Call {
  /** The callee as written, without spaces: `dataLayer.push`. */
  name: string;
  /** Where the callee starts. */
  index: number;
  /** The argument text with strings kept, and with strings and comments blanked. */
  args: string;
  bare: string;
}

/** Calls in a file whose callee matches `callee` (a global regex that ends at the opening bracket). */
export function callsOf(text: string, callee: RegExp): Call[] {
  const code = scrub(text, false);
  const bare = scrub(text, true);
  const out: Call[] = [];
  for (const m of bare.matchAll(callee)) {
    const open = m.index + m[0].length - 1;
    const close = matching(bare, open);
    if (close < 0) continue;
    out.push({
      name: m[0]
        .slice(0, -1)
        .replace(/\s+/g, "")
        .replace(/\?\./g, ".")
        .replace(/^window\./, ""),
      index: m.index,
      args: code.slice(open + 1, close),
      bare: bare.slice(open + 1, close),
    });
  }
  return out;
}

/** Last words of a field name that make it personal: `email`, `userEmail`, `contact_phone`. */
const PERSONAL = new Set([
  "email",
  "e_mail",
  "email_address",
  "phone",
  "phone_number",
  "mobile",
  "telephone",
  "tel",
  "first_name",
  "last_name",
  "full_name",
  "surname",
  "postcode",
  "post_code",
  "zip",
  "zip_code",
  "street_address",
  "dob",
  "date_of_birth",
]);

export function isPersonalName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
  const one = words.slice(-1).join("_");
  const two = words.slice(-2).join("_");
  return PERSONAL.has(one) || PERSONAL.has(two);
}

/** A value that is plainly not the visitor's: a literal, or something hashed or masked on its way. */
const LITERAL = /^\s*(?:["']|\d|true\b|false\b|null\b|undefined\b)/;
const PROTECTED = /hash|sha\d|md5|digest|redact|mask|anonym|pseudonym/i;

/** A file that handles a submitted form: only then is a bare `values` or `body` taken to be the form. */
const FORM_FILE =
  /\bformData\b|\bFormData\b|\bhandleSubmit\b|\bonSubmit\b|\buseForm\b|\bsafeParse\(|\b(?:request|req)\.(?:json|formData|body)\b|["']use server["']/;
const WHOLE_FORM =
  /(?:\.\.\.\s*|[(,]\s*)(?:formData|formValues|values|fields|form|submission|fd)\s*(?=[,)}]|$)|Object\s*\.\s*fromEntries\s*\(|\b(?:request|req)\s*\.\s*body\b|await\s+(?:request|req)\s*\.\s*(?:json|formData)\s*\(/;

/**
 * What in a call's arguments is the visitor's personal data: the name of the field (`email`), or
 * `the whole form` when a file that handles a form passes its values on. Undefined when nothing is.
 */
export function personalIn(call: Call, fileText: string): string | undefined {
  const near = (i: number, len: number): string =>
    call.args.slice(Math.max(0, i - 40), i + len + 40);
  // { email: values.email } and { "email": x }: a personal key whose value is not a literal or protected.
  // A key that is only words inside a string or template ("morning email: ...") is blanked in `bare`.
  for (const m of call.args.matchAll(/(?<![\w$.])(["']?)([A-Za-z_][\w-]*)\1\s*:\s*([^,}\n]*)/g)) {
    const [, quote = "", key = "", value = ""] = m;
    const live =
      quote === "" ? call.bare[m.index] === call.args[m.index] : call.bare[m.index] === quote;
    if (live && isPersonalName(key) && !LITERAL.test(value) && !PROTECTED.test(value)) return key;
  }
  // { email } and identify(email, ...): the variable is the personal field.
  for (const m of call.bare.matchAll(/(?:^|[{,(])\s*([A-Za-z_$][\w$]*)\s*(?=[,})]|$)/g)) {
    const key = m[1] ?? "";
    if (isPersonalName(key) && !PROTECTED.test(near(m.index, m[0].length))) return key;
  }
  // values.email, form.phone
  for (const m of call.bare.matchAll(/[\w$]+\s*\.\s*([A-Za-z_]\w*)\b/g)) {
    const key = m[1] ?? "";
    if (isPersonalName(key) && !PROTECTED.test(near(m.index, m[0].length))) return key;
  }
  // formData.get("email")
  for (const m of call.args.matchAll(/\.\s*get\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const key = m[1] ?? "";
    if (
      call.bare[m.index] === "." &&
      isPersonalName(key) &&
      !PROTECTED.test(near(m.index, m[0].length))
    )
      return key;
  }
  if (FORM_FILE.test(fileText) && WHOLE_FORM.test(call.bare) && !PROTECTED.test(call.args))
    return "the whole form";
  return undefined;
}
