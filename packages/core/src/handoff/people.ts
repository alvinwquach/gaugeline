import { createHash } from "node:crypto";
import type { Party } from "./types.js";

/** An address as it is compared: trimmed and in lower case. Nothing else is changed (a plus tag is part of the address). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * An address as it may be shown in a report: its first letter and its domain, "o***@client.example".
 * Anything that is not an address becomes "***", so text is never echoed by accident.
 */
export function maskEmail(email: string): string {
  const parts = normalizeEmail(email).split("@");
  const [name, domain] = parts;
  if (parts.length !== 2 || !name || !domain || !domain.includes(".")) return "***";
  const first = [...name][0] ?? "";
  return `${first}***@${domain}`;
}

export interface PeopleConfig {
  clientEmails?: readonly string[] | undefined;
  freelancerEmails?: readonly string[] | undefined;
  sameAs?: readonly (readonly string[])[] | undefined;
}

/** Who an address belongs to, by gaugeline.handoff.json. */
export interface People {
  /** True when at least one client address was given: without one nothing can be said about the client. */
  readonly hasClient: boolean;
  partyOf(email: string): Exclude<Party, "unknown">;
  /** An opaque key for one person: addresses grouped under `sameAs` share it. It holds no part of an address. */
  personOf(email: string): string;
}

const keyOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

export function createPeople(config: PeopleConfig): People {
  const clients: ReadonlySet<string> = new Set((config.clientEmails ?? []).map(normalizeEmail));
  const freelancers: ReadonlySet<string> = new Set(
    (config.freelancerEmails ?? []).map(normalizeEmail),
  );
  // Union-find over a Map: an address points at the address that stands for its person (the smaller
  // string, so the choice never depends on the order they were written). Groups that share an address
  // are one person, however they were written.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    for (let p = parent.get(root); p !== undefined; p = parent.get(root)) root = p;
    return root;
  };
  const link = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const group of config.sameAs ?? []) {
    const [first, ...rest] = group.map(normalizeEmail);
    if (first !== undefined) for (const other of rest) link(first, other);
  }
  return {
    hasClient: clients.size > 0,
    partyOf(email) {
      const e = normalizeEmail(email);
      const root = find(e);
      const known = (set: ReadonlySet<string>) =>
        set.has(e) || [...set].some((x) => find(x) === root);
      if (known(clients)) return "client";
      if (known(freelancers)) return "freelancer";
      return "other";
    },
    personOf(email) {
      return keyOf(find(normalizeEmail(email)));
    },
  };
}
