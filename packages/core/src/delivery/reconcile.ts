import { createHash } from "node:crypto";

/** A paid order, reduced to when it was paid and who it was paid by. Nothing else is kept. */
export interface PaidOrder {
  /** When the order was paid, as milliseconds since 1970. */
  at: number;
  /** The address on the order, or null when the order has none. */
  email: string | null;
}

/** An email the provider says it sent: when, and to whom. The subject and the body are never read. */
export interface SentEmail {
  at: number;
  to: readonly string[];
}

export interface Reconciled {
  paid: number;
  sent: number;
  /** Paid orders with no sent email behind them. Never negative. */
  unmatched: number;
  /** UTC days in order, with the number paid and the number sent on each. */
  byDay: { day: string; paid: number; sent: number }[];
}

const ANGLE = /<([^<>]+)>/;

/**
 * The key an address is matched on: the SHA-256 (hex) of the address, trimmed and lower-cased, read
 * from inside a display name (a name, then the address in angle brackets) when there is one. Null when there is no
 * address. Only this hash is ever held, so a log of the matching map holds no address.
 */
export function recipientKey(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  const inside = ANGLE.exec(address)?.[1];
  const clean = (inside ?? address).trim().toLowerCase();
  if (clean === "") return null;
  return createHash("sha256").update(clean, "utf8").digest("hex");
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Compare the orders that were paid with the emails that were sent, in memory.
 *
 * A Map<string, number> counts the sent emails by recipient key (a multiset: a customer who bought
 * twice needs two emails). Each order then takes one from its key's count, or is unmatched when the
 * count is gone. Matching ignores the day, so an order at 23:59 and its email at 00:01 match; the
 * days are only for the count by day. The Map holds hashes, is local to this call and is dropped
 * when it returns, and the result holds counts and days only.
 */
export function reconcile(paid: readonly PaidOrder[], sent: readonly SentEmail[]): Reconciled {
  const remaining = new Map<string, number>();
  for (const email of sent) {
    // One count per recipient per email, even if the address is listed twice on it.
    for (const key of new Set(email.to.flatMap((t) => recipientKey(t) ?? []))) {
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
  }
  let unmatched = 0;
  for (const order of paid) {
    const key = recipientKey(order.email);
    const left = key === null ? 0 : (remaining.get(key) ?? 0);
    if (key !== null && left > 0) remaining.set(key, left - 1);
    else unmatched += 1;
  }
  const days = new Map<string, { paid: number; sent: number }>();
  const bucket = (ms: number) => {
    const d = day(ms);
    let b = days.get(d);
    if (!b) {
      b = { paid: 0, sent: 0 };
      days.set(d, b);
    }
    return b;
  };
  for (const o of paid) bucket(o.at).paid += 1;
  for (const e of sent) bucket(e.at).sent += 1;
  return {
    paid: paid.length,
    sent: sent.length,
    unmatched,
    byDay: [...days]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([d, c]) => ({ day: d, paid: c.paid, sent: c.sent })),
  };
}
