import { test as base, expect } from "@playwright/test";
import { createContent } from "./content.js";
import type { Content, ContentOptions } from "./content.js";

export type { Content, ContentOptions, PublishedDoc, Reader, SkippedDoc } from "./content.js";

/**
 * Playwright's `test` with one more fixture, `content`, and one option, `gaugeline`, set with
 * `test.use({ gaugeline: { ... } })` or in the `use` block of playwright.config.ts.
 */
export const test = base.extend<{ content: Content; gaugeline: ContentOptions }>({
  gaugeline: [{}, { option: true }],
  content: async ({ gaugeline, baseURL }, use, testInfo) => {
    await use(
      createContent(gaugeline, {
        env: process.env,
        baseURL,
        annotate: (type, description) => testInfo.annotations.push({ type, description }),
      }),
    );
  },
});

export { expect };
