/**
 * Every string inside parsed JSON-LD that parses as an http(s) URL, in document order. Walked with
 * an explicit stack, not recursion: page content is untrusted, and 10,000 levels of nesting must not
 * take the run down. Each object or array is visited once, so a cycle cannot loop.
 */
export function collectUrls(json: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  // Reversed pushes keep document order when popping.
  const stack: unknown[] = [json];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value.trim())) {
        try {
          out.push(new URL(value.trim()).href);
        } catch {
          // not a URL after all
        }
      }
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      const children = Array.isArray(value)
        ? value
        : Object.values(value as Record<string, unknown>);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return out;
}

/** schema.org type names: "Product", "https://schema.org/Product" and "schema:Product" are one type. */
export function schemaType(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "")
    .replace(/^schema:/i, "");
}

/** Every @type in JSON-LD, walked with an explicit stack (nested objects and @graph included). */
export function jsonLdTypes(json: unknown): Set<string> {
  const types = new Set<string>();
  const stack: unknown[] = [json];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const v of value) stack.push(v);
      continue;
    }
    const obj = value as Record<string, unknown>;
    const t = obj["@type"];
    for (const name of Array.isArray(t) ? t : [t])
      if (typeof name === "string") types.add(schemaType(name));
    for (const v of Object.values(obj)) stack.push(v);
  }
  return types;
}
