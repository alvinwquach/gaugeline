/**
 * The payload an adapter may send (AG-23). Only the privacy gate (privacy.ts) can make one: `issueGatedPayload`
 * records the object in a WeakSet that lives in this module, and `isGatedPayload` asks the same set, so an
 * object built by hand, a string, or a look-alike with the same methods is not one. The type is branded, so a
 * plain string does not compile where a payload is expected. A test (privacy-boundary.test.ts) fails if any
 * other file in the package imports `issueGatedPayload`, or if anything but the gateway calls an adapter.
 */
declare const gatedBrand: unique symbol;

/** The text that came out of the privacy gate. An adapter sends this and nothing else. */
export interface GatedPayload {
  readonly [gatedBrand]: true;
  /** The exact text, already redacted and quoted by the gate. */
  text(): string;
}

const issued = new WeakSet<object>();

/** Makes a payload. Only privacy.ts may call this; the boundary test enforces it. */
export function issueGatedPayload(text: string): GatedPayload {
  const payload = Object.freeze({
    text: () => text,
  }) as unknown as GatedPayload;
  issued.add(payload);
  return payload;
}

/** Whether `value` is a payload the gate made. A runtime check for an adapter, which a type cannot stop a cast from skipping. */
export function isGatedPayload(value: unknown): value is GatedPayload {
  return typeof value === "object" && value !== null && issued.has(value);
}
