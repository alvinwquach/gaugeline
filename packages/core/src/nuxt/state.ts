/**
 * Readers for the state a Nuxt page embeds: the __NUXT_DATA__ script (a JSON array in devalue's
 * flat format, which is what a page's data and useState values are sent as) and the
 * window.__NUXT__.config literal (the public runtime config). Everything here is a pure,
 * linear-time scan over capped text: no regular expression with nested quantifiers, no eval, no
 * recursion over the page's own structure. A value is classified, never kept: callers get field
 * names and kinds.
 */

/** The most script text read from one page or payload: a larger one is unread, not guessed at. */
export const NUXT_STATE_MAX_BYTES = 2 * 1024 * 1024;
/** The most slots of one flat payload that are walked. */
export const NUXT_STATE_MAX_SLOTS = 100_000;
/** The most text of one window.__NUXT__ literal that is scanned. */
export const NUXT_CONFIG_MAX_CHARS = 256 * 1024;

export type DataScript =
  | { kind: "none" }
  | { kind: "inline"; text: string }
  /** The payload is a separate file (payload extraction): its address, as written. */
  | { kind: "external"; src: string }
  | { kind: "unread"; reason: string };

/** The __NUXT_DATA__ script of an HTML body, found by marker (no HTML parse of a hostile page). */
export function findDataScript(body: string, truncated: boolean): DataScript {
  for (const needle of ["__NUXT_DATA__", "data-nuxt-data"]) {
    let at = body.indexOf(needle);
    for (let tries = 0; at !== -1 && tries < 4; tries++, at = body.indexOf(needle, at + 1)) {
      const start = body.lastIndexOf("<script", at);
      if (start === -1) continue;
      const openEnd = body.indexOf(">", start);
      if (openEnd === -1 || openEnd < at) continue;
      const tag = body.slice(start, openEnd);
      const close = body.indexOf("</script", openEnd);
      if (close === -1)
        return {
          kind: "unread",
          reason: truncated
            ? "the page was cut at the size limit inside its data script"
            : "the data script is not closed",
        };
      if (close - openEnd > NUXT_STATE_MAX_BYTES)
        return { kind: "unread", reason: "the data script is larger than 2 MB" };
      const src = /\bdata-src=["']([^"']{1,500})["']/.exec(tag)?.[1];
      if (src) return { kind: "external", src };
      return { kind: "inline", text: body.slice(openEnd + 1, close) };
    }
  }
  return { kind: "none" };
}

/** A flat devalue payload from its text, or why it is not one. */
export function parseFlat(text: string): { flat: unknown[] } | { reason: string } {
  if (text.length > NUXT_STATE_MAX_BYTES) return { reason: "the payload is larger than 2 MB" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "the payload is not JSON" };
  }
  if (!Array.isArray(value)) return { reason: "the payload is not a flat devalue array" };
  if (value.length > NUXT_STATE_MAX_SLOTS) return { reason: "the payload has too many values" };
  return { flat: value };
}

export type FieldKind = "text" | "number" | "flag" | "empty" | "object" | "list" | "other";

export interface StateField {
  name: string;
  kind: FieldKind;
}

/** Wrappers Nuxt's payload reducers put around a value: the value is the slot they point at. */
const WRAPPERS = new Set(["Ref", "ShallowRef", "Reactive", "ShallowReactive"]);

/** The slot a reference points at, through wrappers, or undefined (a special value such as -1). */
function slotOf(flat: readonly unknown[], ref: unknown): unknown {
  let at = ref;
  for (let hops = 0; hops < 4; hops++) {
    if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at >= flat.length)
      return undefined;
    const v = flat[at];
    if (Array.isArray(v) && typeof v[0] === "string" && WRAPPERS.has(v[0])) {
      at = v[1];
      continue;
    }
    return v;
  }
  return undefined;
}

function kindOf(v: unknown): FieldKind {
  if (typeof v === "string") return v === "" ? "empty" : "text";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "flag";
  if (v === null || v === undefined) return "empty";
  if (Array.isArray(v)) return typeof v[0] === "string" ? "other" : "list";
  return "object";
}

/** Every field name of every object in a flat payload, with the kind of its value (never the value). */
export function payloadFields(flat: readonly unknown[]): StateField[] {
  const out: StateField[] = [];
  for (const slot of flat) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue;
    // Own keys only; a "__proto__" key from JSON.parse is an ordinary own property here.
    for (const [name, ref] of Object.entries(slot))
      out.push({ name, kind: kindOf(slotOf(flat, ref)) });
  }
  return out;
}

/** The value of a useState key in the payload (stored as "$s" + key), as its slot, or undefined. */
function stateSlot(flat: readonly unknown[], key: string): { found: boolean; value?: unknown } {
  for (const slot of flat) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue;
    for (const [name, ref] of Object.entries(slot))
      if (name === `$s${key}`) return { found: true, value: slotOf(flat, ref) };
  }
  return { found: false };
}

/** Whether the server rendered the page with usePreviewMode switched on: "unknown" when no state was sent. */
export function previewState(flat: readonly unknown[]): "on" | "off" | "unknown" {
  const s = stateSlot(flat, "_preview-state");
  if (!s.found || typeof s.value !== "object" || s.value === null || Array.isArray(s.value))
    return "unknown";
  const enabled = (s.value as Record<string, unknown>).enabled;
  return slotOf(flat, enabled) === true ? "on" : "off";
}

/** Whether the payload carries the DevTools plugin's state (useState("__nuxt_devtools__"), added only in a dev build). */
export function hasDevtoolsState(flat: readonly unknown[]): boolean {
  return stateSlot(flat, "__nuxt_devtools__").found;
}

/** The public runtime config literal(s) of window.__NUXT__: field names and kinds, by a bounded scan. */
export function configFields(body: string): StateField[] {
  const out: StateField[] = [];
  let at = body.indexOf("window.__NUXT__");
  for (
    let tries = 0;
    at !== -1 && tries < 4;
    tries++, at = body.indexOf("window.__NUXT__", at + 1)
  ) {
    const end = body.indexOf("</script", at);
    const stop = Math.min(end === -1 ? body.length : end, at + NUXT_CONFIG_MAX_CHARS);
    const eq = body.indexOf("=", at);
    if (eq === -1 || eq > stop) continue;
    out.push(...scanLiteral(body, eq + 1, stop));
  }
  return out;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

function valueKind(src: string, from: number, stop: number): FieldKind {
  let i = from;
  while (i < stop && (src[i] === " " || src[i] === "\n" || src[i] === "\t")) i++;
  const c = src[i];
  if (c === '"' || c === "'") return src[i + 1] === c ? "empty" : "text";
  if (c === "{") return "object";
  if (c === "[") return "list";
  if (c !== undefined && /[\d-]/.test(c)) return "number";
  if (c === "!" || src.startsWith("true", i) || src.startsWith("false", i)) return "flag";
  if (src.startsWith("null", i) || src.startsWith("void", i)) return "empty";
  return "other";
}

/** The object literal starting at the first "{" after `from`: its keys at any depth, one pass. */
function scanLiteral(src: string, from: number, stop: number): StateField[] {
  const out: StateField[] = [];
  let i = src.indexOf("{", from);
  if (i === -1 || i >= stop) return out;
  let depth = 0;
  while (i < stop) {
    const c = src[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let text = "";
      while (j < stop && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (text.length < 200) text += src[j];
        j++;
      }
      i = j + 1;
      let k = i;
      while (k < stop && src[k] === " ") k++;
      if (depth > 0 && src[k] === ":" && c !== "`")
        out.push({ name: text, kind: valueKind(src, k + 1, stop) });
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < stop && IDENT_PART.test(src[j] as string)) j++;
      let k = j;
      while (k < stop && src[k] === " ") k++;
      if (depth > 0 && src[k] === ":")
        out.push({ name: src.slice(i, Math.min(j, i + 200)), kind: valueKind(src, k + 1, stop) });
      i = j;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth <= 0) break;
    }
    i++;
  }
  return out;
}

export type PrivateKind =
  | "a service role key"
  | "a secret"
  | "a password"
  | "a private key"
  | "an access token"
  | "an API key";

/** Names split into lower-case words: "supabaseServiceRole" and "SUPABASE_SERVICE_ROLE" are alike. */
function words(name: string): string {
  return `_${name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}_`;
}

const NAME_RULES: readonly (readonly [RegExp, PrivateKind])[] = [
  [/_service_role_/, "a service role key"],
  [/_secrets?_/, "a secret"],
  [/_(?:password|passwd|passphrase|pwd)_/, "a password"],
  [/_private_key_/, "a private key"],
  [/_(?:access|auth|bearer|refresh|session)_token_/, "an access token"],
  [/_api_key_/, "an API key"],
];

/** What a field name says it holds, when it looks private; the first rule that matches. */
export function privateKindOf(name: string): PrivateKind | undefined {
  const w = words(name);
  return NAME_RULES.find(([re]) => re.test(w))?.[1];
}
