import type { FakeSanity } from "./sanity-counts.js";

/**
 * Every text value in the invented Northfield dataset starts with this, so a test can search a
 * request log or an output for it and know a value from the content got out.
 */
export const CONTENT_MARKER = "NORTHFIELD-MARKER";

/**
 * Northfield Coaching's invented dataset for `gaugeline query --suggest`: 12 published resources
 * and 2 drafts. Every text value carries CONTENT_MARKER. publishedAt is on 6 of the 12, gatedFile on
 * 4, and the heroImage's alt on 6; every other field is on all 12. The drafts have a field
 * (`draftOnly`) that no published resource has. Nothing here was recorded from a real dataset.
 */
export function northfieldResources(): Record<string, unknown>[] {
  const published = Array.from({ length: 12 }, (_, k) => {
    const i = k + 1;
    const n = String(i).padStart(2, "0");
    return {
      _id: `resource-${n}`,
      _type: "resource",
      _updatedAt: `2026-10-${String(30 - i).padStart(2, "0")}T09:00:00Z`,
      title: `${CONTENT_MARKER} title ${n}`,
      slug: { _type: "slug", current: `${CONTENT_MARKER.toLowerCase()}-slug-${n}` },
      summary: `${CONTENT_MARKER} summary ${n}`,
      topic: { _type: "reference", _ref: `topic-${(i % 3) + 1}` },
      body: [
        {
          _type: "block",
          _key: `b${n}`,
          style: "normal",
          children: [{ _type: "span", _key: `s${n}`, text: `${CONTENT_MARKER} body ${n}` }],
        },
      ],
      heroImage: {
        _type: "image",
        asset: { _type: "reference", _ref: `image-${CONTENT_MARKER}${n}-800x600-jpg` },
        ...(i % 2 === 0 ? { alt: `${CONTENT_MARKER} alt ${n}` } : {}),
      },
      tags: [`${CONTENT_MARKER} tag a`, `${CONTENT_MARKER} tag b`],
      ...(i <= 6 ? { publishedAt: `2026-0${(i % 9) + 1}-01T08:00:00Z` } : {}),
      ...(i <= 4
        ? {
            gatedFile: {
              _type: "file",
              asset: { _type: "reference", _ref: `file-${CONTENT_MARKER}${n}-pdf` },
            },
          }
        : {}),
    } satisfies Record<string, unknown>;
  });
  const drafts = [1, 2].map((i) => ({
    ...published[i - 1],
    _id: `drafts.resource-0${i}`,
    _updatedAt: "2026-11-09T09:00:00Z",
    draftOnly: `${CONTENT_MARKER} draft only`,
  }));
  return [...drafts, ...published];
}

/** The fake Sanity for --suggest: the Northfield resources, and counts for the same types. */
export const NORTHFIELD_CONTENT: FakeSanity = {
  types: { resource: { total: 12 } },
  content: { resource: northfieldResources(), topic: [] },
};
