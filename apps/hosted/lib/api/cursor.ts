/** An opaque page marker: the last row's sort value and id, so the next page starts after it. */
export interface Cursor {
  t: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A time as Postgres prints it for timestamptz: "2026-11-12 03:00:00.123456+00". Nothing else is a cursor. */
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export const isUuid = (s: string): boolean => UUID.test(s);

/** The digits are a real date (no month 99), and Postgres can hold it. */
function validTime(t: string): boolean {
  const d = new Date(`${t.slice(0, 10)}T${t.slice(11, 19)}Z`);
  return (
    Number.isFinite(d.getTime()) &&
    d.toISOString().startsWith(t.slice(0, 10)) &&
    Number(t.slice(0, 4)) >= 1
  );
}

/** A drafts cursor (AG-08) carries `k: "drafts"`, so it cannot be passed to /runs, nor a runs cursor to /drafts. */
export function encodeCursor(c: Cursor, kind?: "drafts"): string {
  return Buffer.from(
    JSON.stringify(kind ? { k: kind, t: c.t, id: c.id } : { t: c.t, id: c.id }),
  ).toString("base64url");
}

/**
 * The cursor, or null for anything this API did not make. A runs cursor holds a time; a findings cursor
 * holds the word "findings": anything else would reach the database as a value it cannot read.
 */
export function decodeCursor(
  text: string,
  kind: "runs" | "findings" | "drafts" = "runs",
): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { t, id, k } = v as Record<string, unknown>;
    if (k !== (kind === "drafts" ? "drafts" : undefined)) return null;
    if (typeof t !== "string" || typeof id !== "string" || !UUID.test(id)) return null;
    if (kind === "findings" ? t !== "findings" : !TIME.test(t) || !validTime(t)) return null;
    return { t, id };
  } catch {
    return null;
  }
}
