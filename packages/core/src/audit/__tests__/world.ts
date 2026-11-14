import {
  CheckRegistry,
  defineCheck,
  type Area,
  type Check,
  type Finding,
  type Severity,
  type Size,
} from "../../model.js";
import { buildResult, type Result } from "../../result.js";
import { servicesConfigSchema, type ServicesConfig } from "../config.js";

/** An invented check: only its area, severity and wording matter to the pack. */
export function check(
  id: string,
  area: Area,
  severity: Severity = "medium",
  size: Size = "S",
): Check<unknown> {
  return defineCheck<unknown>({
    id,
    area,
    severity,
    title: `Title of ${id}`,
    what: `What is wrong with ${id}.`,
    why: `Why ${id} matters to the owner.`,
    fix: `How to fix ${id}.`,
    tech: `Tech line of ${id}`,
    size,
    done: `${id} is no longer reported when Gaugeline runs again.`,
    estimateChanges: `How many places ${id} is hardcoded in.`,
    run: () => [],
  });
}

export function registry(...checks: Check<unknown>[]): CheckRegistry {
  const r = new CheckRegistry();
  for (const c of checks) r.register(c);
  return r;
}

export function finding(
  checkId: string,
  severity: Severity = "medium",
  evidence = `${checkId} evidence`,
  url = "https://marlowe-bar.example/",
): Finding {
  return { checkId, severity, title: `Title of ${checkId}`, evidence, url };
}

export function resultOf(
  findings: Finding[],
  extra: Partial<Parameters<typeof buildResult>[0]> = {},
): Result {
  return buildResult({
    url: "https://marlowe-bar.example/",
    startedAt: new Date("2026-11-10T09:00:00.000Z"),
    findings,
    passed: [],
    failed: [],
    ...extra,
  });
}

/** Six invented checks across three areas, the way a first run on a bar's site might find them. */
export const CHECKS = registry(
  check("canonical-elsewhere", "Search & sharing", "high"),
  check("share-image-missing", "Search & sharing", "low"),
  check("viewport-missing", "Visitors", "medium"),
  check("alt-missing", "Visitors", "medium"),
  check("menu-price-mismatch", "Sales & prices", "high", "M"),
  check("spf-missing", "Security & email", "medium"),
);

export const FINDINGS: Finding[] = [
  finding("share-image-missing", "low"),
  finding("canonical-elsewhere", "high"),
  finding("viewport-missing", "medium"),
  finding("alt-missing", "medium", "3 images have no alt text"),
  finding("alt-missing", "medium", "the logo has no alt text"),
  finding("menu-price-mismatch", "high"),
];

/** A freelancer's two packages and one that nothing on this site needs. */
export const SERVICES: ServicesConfig = servicesConfigSchema.parse({
  currency: "usd",
  services: [
    {
      name: "Search and sharing tidy-up",
      covers: { checks: ["canonical-elsewhere", "share-image-missing"] },
      price: { from: 450, to: 700 },
      hours: { from: 4, to: 6 },
      notIncluded: ["New page copy", "Paid search"],
    },
    {
      name: "Phone and accessibility pass",
      covers: { areas: ["Visitors"] },
      price: { from: 600, to: 900 },
      notIncluded: ["A redesign"],
    },
    {
      name: "Email set-up",
      covers: { areas: ["Security & email"] },
      price: { from: 150, to: 150 },
    },
  ],
  brand: {
    name: "Harbour Studio",
    logoUrl: "https://harbour-studio.example/logo.png",
    contact: "Mia Okafor, hello at harbour-studio.example, 555 0142",
  },
});
