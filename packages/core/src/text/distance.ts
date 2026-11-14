/**
 * Damerau-Levenshtein distance (optimal string alignment: insert, delete, substitute, and swap two
 * neighbouring letters, each counting 1), bounded: once every path is past `max` it returns
 * max + 1 without finishing. Two rows of the table are kept, plus the one before for swaps.
 */
export function damerau(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (prevPrev[j - 2] ?? 0) + 1);
      row[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  const d = prev[b.length] ?? max + 1;
  return d > max ? max + 1 : d;
}
