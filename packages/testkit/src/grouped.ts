/**
 * Plan rules report one finding per group, never one per pair or per row. Throws naming the
 * check and key when two findings share both, or when a finding has no group.
 */
export function assertGrouped(
  findings: readonly { checkId: string; group?: { key: string; lines: number[] } }[],
): void {
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.group) throw new Error(`${f.checkId}: a plan finding without a group`);
    const k = `${f.checkId}\u0000${f.group.key}`;
    if (seen.has(k))
      throw new Error(`${f.checkId}: two findings for "${f.group.key}"; report one group`);
    seen.add(k);
    if (new Set(f.group.lines).size !== f.group.lines.length)
      throw new Error(`${f.checkId}: "${f.group.key}" lists a line twice`);
  }
}
