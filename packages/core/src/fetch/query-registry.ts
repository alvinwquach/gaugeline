import {
  allowProblems,
  type QueryMethod,
  type ReadOnlyQueryAllow,
  type RegisteredQueryAllow,
} from "./read-only-query.js";

/**
 * The registry of read-only query endpoints (ADR-0006). An adapter's own file writes its entries
 * once, at module load, with `registerQueryAllow`; `fetcher.query()` takes an entry's id and looks
 * the entry up here. Code that has a Fetcher cannot invent an endpoint: an id nobody registered is
 * refused. A test (`post-boundary.test.ts`) fails if any file but an adapter's registers an entry
 * or calls `.query(`.
 */
const entries = new Map<string, RegisteredQueryAllow>();

/**
 * The method every stored entry carries, and the only one: the entry type has no `method` field, so
 * an adapter cannot vary it, and PUT, PATCH and DELETE cannot be registered (ADR-0006, Amendment 1).
 */
const SENT_AS: QueryMethod = "POST";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Check an entry, fix its method to POST, freeze it and add it to the registry; returns the frozen
 * entry for the adapter to export. Throws when the entry is malformed (a `method` key of any value
 * included: the registry fixes the method), or when another entry already has its id.
 * Registering the same entry again (a module loaded twice) is fine.
 */
export function registerQueryAllow(entry: ReadOnlyQueryAllow): RegisteredQueryAllow {
  const problems = allowProblems(entry);
  if (problems.length > 0)
    throw new TypeError(`Query allowlist entry ${String(entry.id)} is not valid: ${problems[0]}.`);
  const frozen = deepFreeze({ ...structuredClone(entry), method: SENT_AS });
  const known = entries.get(frozen.id);
  if (known !== undefined) {
    if (JSON.stringify(known) !== JSON.stringify(frozen))
      throw new TypeError(`Query allowlist entry ${frozen.id} is already registered, differently.`);
    return known;
  }
  entries.set(frozen.id, frozen);
  return frozen;
}

/** The registered entry with this id, or undefined. */
export function resolveQueryAllow(id: string): RegisteredQueryAllow | undefined {
  return typeof id === "string" ? entries.get(id) : undefined;
}

/** Every registered entry, by id. */
export function registeredQueryAllows(): readonly RegisteredQueryAllow[] {
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}
