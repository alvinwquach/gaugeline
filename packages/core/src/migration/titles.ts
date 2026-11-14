/**
 * Whether a page kept its title. The rule is plain and the same every run: both titles are lower-cased,
 * their accents and punctuation (the bar, dash or colon between a page's name and the site's) are
 * dropped, and spaces are collapsed. They match when they are equal, or when one holds the other as a
 * whole run of words, so adding or dropping " | Wren Bakehouse" is not a change and a reworded title is.
 */
export function normaliseTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `inner` appears in `outer` as whole words. Both are already normalised. */
function holds(outer: string, inner: string): boolean {
  if (inner === "") return false;
  return ` ${outer} `.includes(` ${inner} `);
}

/** One old title against one new one. */
export function sameTitle(a: string, b: string): boolean {
  const x = normaliseTitle(a);
  const y = normaliseTitle(b);
  if (x === "" || y === "") return false;
  return x === y || holds(x, y) || holds(y, x);
}

/**
 * The page kept its title when what it was called before matches what it calls itself now. Before is the
 * list's title (a WordPress post's name, an export's title column) and the old page's <title>. Now is the
 * new <title>, og:title and first heading. The old <title> is compared with the new <title> and og:title
 * only: a heading that is just the site's name would otherwise match every old title that ends with it.
 */
export function titleKept(
  before: { listed?: string; page?: string },
  now: { title?: string; og?: string; h1?: string },
): boolean {
  const titles = [now.title, now.og].filter((t): t is string => t !== undefined);
  const all = [...titles, ...(now.h1 !== undefined ? [now.h1] : [])];
  return (
    (before.page !== undefined && titles.some((n) => sameTitle(before.page ?? "", n))) ||
    (before.listed !== undefined && all.some((n) => sameTitle(before.listed ?? "", n)))
  );
}
