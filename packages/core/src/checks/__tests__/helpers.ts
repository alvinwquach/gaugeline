import type { CheckContext } from "../../model.js";
import type { PageSnapshot } from "../../snapshot.js";

export const URL0 = "https://shop.example/menu";

/** A small, valid snapshot literal; each test overrides what it is about. */
export function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  const finalUrl = overrides.finalUrl ?? URL0;
  return {
    requestedUrl: finalUrl,
    finalUrl,
    status: 200,
    hops: [{ url: finalUrl, status: 200, headers: { "content-type": "text/html" }, ms: 1 }],
    title: "Menu",
    canonical: finalUrl,
    canonicals: [finalUrl],
    headings: [],
    links: [],
    images: [],
    jsonLd: [],
    jsonLdErrors: [],
    og: {},
    scripts: [],
    forms: [],
    ids: new Set(),
    wordCount: 300,
    contentWordCount: 250,
    stega: false,
    ...overrides,
  };
}

export const ctx: CheckContext = { warn: () => undefined };
