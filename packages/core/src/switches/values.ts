/**
 * Turning what a source returned into a state. Every function here says "not known" (undefined)
 * for anything it does not recognise: a state is never guessed.
 */

const ON = new Set(["true", "on", "yes", "enabled", "open", "1"]);
const OFF = new Set(["false", "off", "no", "disabled", "closed", "0"]);

/** A switch's value: true or false, 1 or 0, or one of the words in the docs, in any case. */
export function switchValue(raw: unknown): "on" | "off" | undefined {
  if (typeof raw === "boolean") return raw ? "on" : "off";
  if (typeof raw === "number") return raw === 1 ? "on" : raw === 0 ? "off" : undefined;
  if (typeof raw !== "string") return undefined;
  const word = raw.trim().toLowerCase();
  return ON.has(word) ? "on" : OFF.has(word) ? "off" : undefined;
}

/** What is left: a whole number, as a number or as text. Zero and below mean nothing is left. */
export function capacityValue(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : undefined;
  if (typeof raw === "string" && /^\s*-?\d{1,15}\s*$/.test(raw)) return Number(raw.trim());
  return undefined;
}
