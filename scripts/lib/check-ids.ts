/** The ids that have ever shipped: append-only. Returns the new lock, or the ids that went missing. */
export function updateLock(
  lock: readonly string[],
  ids: readonly string[],
): { ok: true; lock: string[] } | { ok: false; missing: string[] } {
  const current = new Set(ids);
  const missing = lock.filter((id) => !current.has(id));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, lock: [...new Set([...lock, ...ids])].sort() };
}
