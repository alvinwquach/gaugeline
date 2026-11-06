import type { MxRecord } from "../../dns.js";

/** An SPF record: the record starts with v=spf1 (RFC 7208 §4.5), not a TXT value that contains it. */
export function isSpf(txt: string): boolean {
  return /^v=spf1(?:\s|$)/i.test(txt.trim());
}

/** A DMARC record starts with v=DMARC1 (RFC 7489 §6.4). */
export function isDmarc(txt: string): boolean {
  return /^v=DMARC1\s*(?:;|$)/i.test(txt.trim());
}

/** DMARC tags, names and values lower-cased: "v=DMARC1 ; P = NONE" -> v: dmarc1, p: none. */
export function dmarcTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    if (name !== "" && !tags.has(name))
      tags.set(
        name,
        part
          .slice(i + 1)
          .trim()
          .toLowerCase(),
      );
  }
  return tags;
}

/** A null MX (RFC 7505): a single record whose exchange is the root, so the domain takes no mail. */
export function nullMx(mx: readonly MxRecord[]): boolean {
  return mx.length === 1 && (mx[0]?.exchange === "" || mx[0]?.exchange === ".");
}

/** The domain receives email: it has MX records, and they aren't a null MX. */
export function receivesMail(mx: readonly MxRecord[]): boolean {
  return mx.length > 0 && !nullMx(mx);
}
