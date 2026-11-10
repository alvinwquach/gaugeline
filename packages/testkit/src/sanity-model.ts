import type { FakeSanity } from "./sanity-counts.js";

/**
 * Every text value in the invented Fernbrook dataset starts with this, so a test can search a
 * request log or an output for it and know a value from the content got out.
 */
export const FERNBROOK_MARKER = "FERNBROOK-MARKER";

/**
 * Fernbrook Physio's invented dataset for the content model checks (X39): 48 published articles and
 * 2 drafts, six practitioners and nine services. The articles `article-32` to `article-48` (17 of
 * them) were written before `summary` became required and have none. Two practitioners still carry
 * `oldSpecialty` and four services `legacyNote`, fields the schema dropped. Every text value carries
 * FERNBROOK_MARKER. The drafts have no summary either, and a published-only question must not count them.
 * Nothing here was recorded from a real dataset.
 */
export function fernbrookContent(): Record<string, Record<string, unknown>[]> {
  const n2 = (n: number) => String(n).padStart(2, "0");
  const article = (n: number, extra: Record<string, unknown> = {}) => ({
    _id: `article-${n2(n)}`,
    _type: "article",
    title: `${FERNBROOK_MARKER} title ${n2(n)}`,
    slug: { _type: "slug", current: `tip-${n2(n)}` },
    author: { _type: "reference", _ref: "practitioner-ana" },
    ...(n <= 31 ? { summary: `${FERNBROOK_MARKER} summary ${n2(n)}` } : {}),
    ...extra,
  });
  const articles = Array.from({ length: 48 }, (_, k) => article(k + 1));
  const drafts = [49, 50].map((n) => ({ ...article(n), _id: `drafts.article-${n}` }));
  const practitioner = (slug: string, extra: Record<string, unknown> = {}) => ({
    _id: `practitioner-${slug}`,
    _type: "practitioner",
    name: `${FERNBROOK_MARKER} name ${slug}`,
    slug: { _type: "slug", current: slug },
    role: `${FERNBROOK_MARKER} role ${slug}`,
    ...extra,
  });
  const practitioners = [
    practitioner("ana"),
    practitioner("ben", { oldSpecialty: `${FERNBROOK_MARKER} old specialty` }),
    practitioner("cai"),
    practitioner("dee", { oldSpecialty: `${FERNBROOK_MARKER} old specialty` }),
    practitioner("eli"),
    practitioner("fay"),
  ];
  const services = Array.from({ length: 9 }, (_, k) => ({
    _id: `service-${n2(k + 1)}`,
    _type: "service",
    name: `${FERNBROOK_MARKER} service ${n2(k + 1)}`,
    slug: { _type: "slug", current: `service-${n2(k + 1)}` },
    price: 40 + k,
    ...(k < 4 ? { legacyNote: `${FERNBROOK_MARKER} legacy note ${n2(k + 1)}` } : {}),
  }));
  return { article: [...drafts, ...articles], practitioner: practitioners, service: services };
}

export const FERNBROOK: FakeSanity = { types: {}, content: fernbrookContent() };
