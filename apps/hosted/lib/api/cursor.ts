/** An opaque page marker: the last row's sort value and id, so the next page starts after it. */
export interface Cursor {
  t: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^[0-9A-Za-z :.+-]{1,64}$/;

export const isUuid = (s: string): boolean => UUID.test(s);

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, id: c.id })).toString("base64url");
}

/** The cursor, or null for anything this API did not make. */
export function decodeCursor(text: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { t, id } = v as Record<string, unknown>;
    if (typeof t !== "string" || !TIME.test(t) || typeof id !== "string" || !UUID.test(id))
      return null;
    return { t, id };
  } catch {
    return null;
  }
}
