import { CANARIES } from "./hostile-site.js";

export interface SlotField {
  untrusted: true;
  source: string;
  text: string;
  truncated: boolean;
  strippedDirectives: number;
}

/**
 * Splits a tool result into its labelled untrusted slots and everything else. A slot is any object with
 * `untrusted: true`; its path has array indexes written as [] so it can be compared with the slots a
 * tool declares. `outside` is the JSON of the result with each slot replaced by a placeholder: the
 * text the server itself wrote.
 */
export function walkSlots(value: unknown): {
  slots: { path: string; field: SlotField }[];
  outside: string;
} {
  const slots: { path: string; field: SlotField }[] = [];
  const visit = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => visit(x, `${path}[]`));
    if (v !== null && typeof v === "object") {
      if ((v as { untrusted?: unknown }).untrusted === true) {
        slots.push({ path, field: v as SlotField });
        return "[slot]";
      }
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, visit(x, path === "" ? k : `${path}.${k}`)]),
      );
    }
    return v;
  };
  return { slots, outside: JSON.stringify(visit(value, "")) };
}

/** The canaries that appear in this text. Empty means no page-derived text leaked into it. */
export function findLeaks(text: string): string[] {
  return CANARIES.filter((k) => text.includes(k));
}
