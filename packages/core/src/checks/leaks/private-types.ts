/**
 * Words that, as the last word of a Sanity document type's name, suggest documents about people:
 * form submissions, orders, bookings. Singular; "orders" and "inquiries" match too. The last word
 * decides, so "contactSubmission" is private-looking and "paymentSettings" is not.
 */
export const PRIVATE_TYPE_WORDS: readonly string[] = Object.freeze([
  "appointment",
  "booking",
  "customer",
  "enquiry",
  "inquiry",
  "invoice",
  "lead",
  "order",
  "patient",
  "registration",
  "reservation",
  "submission",
  "subscriber",
]);

const WORDS: ReadonlySet<string> = new Set(PRIVATE_TYPE_WORDS);

/** The last word of a type name, lower case and singular: "contactSubmissions" -> "submission". */
function lastWord(type: string): string {
  const words = type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter((w) => w !== "");
  const w = (words.at(-1) ?? "").toLowerCase();
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Sanity's own types (sanity.imageAsset, system.group) are never private-looking. */
export function isPrivateType(type: string): boolean {
  if (/^(?:sanity|system)\./.test(type)) return false;
  return WORDS.has(lastWord(type));
}
