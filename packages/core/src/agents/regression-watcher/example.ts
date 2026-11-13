/**
 * The invented two nights the docs page and the eval set share (AG-13): a bakery's site on the night of
 * 12 November and again on the night of 13 November. No real client, venue, address or person.
 */
import type { RegressionFinding } from "./compare.js";

const row = (id: string, severity: RegressionFinding["severity"], title: string) => ({
  id,
  severity,
  title,
});

/** Thursday night: four findings, none urgent. */
export const EXAMPLE_PREVIOUS = {
  runId: "r-20261112T020000Z",
  takenAt: "2026-11-12T02:00:00.000Z",
  findings: [
    row("f-201", "medium", "Menu page has no canonical link"),
    row("f-202", "low", "Hero image has no alt text"),
    row("f-203", "low", "Certificate expires in 30 days"),
    row("f-204", "low", "Sitemap lists a page that is gone"),
  ],
};

/**
 * Friday night: the certificate is now 9 days from expiry (it went up two steps), the booking form lost its
 * submit button (new), the sitemap was tidied (fixed), and the hero image is still the same.
 */
export const EXAMPLE_CURRENT = {
  runId: "r-20261113T020000Z",
  takenAt: "2026-11-13T02:00:00.000Z",
  findings: [
    row("f-201", "medium", "Menu page has no canonical link"),
    row("f-202", "low", "Hero image has no alt text"),
    row("f-203", "high", "Certificate expires in 9 days"),
    row("f-205", "high", "Booking form has no submit button"),
  ],
};
