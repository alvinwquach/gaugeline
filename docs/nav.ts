/**
 * The docs sidebar, as data. Groups and slugs are exactly the published site's window.DOCS: slugs are
 * public addresses, so never rename one without a redirect (docs/slugs.lock.json pins them).
 */
import { ADAPTER_PAGES } from "./adapter-pages.generated.js";

export interface NavPage {
  slug: string;
  title: string;
  soon?: boolean;
}

export interface NavGroup {
  group: string;
  soon?: boolean;
  pages: NavPage[];
}

export const NAV: NavGroup[] = [
  {
    group: "Getting started",
    pages: [
      { slug: "introduction", title: "Introduction" },
      { slug: "quick-start", title: "Quick start" },
      { slug: "how-it-works", title: "How it works" },
    ],
  },
  {
    group: "The site check",
    pages: [
      { slug: "running-a-check", title: "Running a check" },
      { slug: "reading-the-report", title: "Reading the report" },
      { slug: "options", title: "Options" },
      { slug: "the-app", title: "Open the app" },
      { slug: "products-and-prices", title: "Products and prices" },
      { slug: "plan-check", title: "Checking a launch plan" },
      { slug: "delivery", title: "Paid downloads and delivery" },
      { slug: "protected-routes", title: "Routes that are hidden, not protected" },
      { slug: "query-check", title: "Checking your queries" },
      { slug: "no-developer", title: "When you don't have a developer" },
      { slug: "ad-landing-pages", title: "Ad landing pages" },
      { slug: "forms-and-crm", title: "Forms and CRM tracking" },
      { slug: "crawler-view", title: "What a crawler gets" },
      { slug: "notifications", title: "Send results anywhere" },
      { slug: "why-not-playwright", title: "Why not just use Playwright?" },
      { slug: "ci", title: "Use it in CI" },
    ],
  },
  {
    group: "Checks",
    pages: [{ slug: "checks", title: "Every check" }],
  },
  {
    group: "Sanity plugin",
    soon: true,
    pages: [
      { slug: "plugin", title: "Install the plugin", soon: true },
      { slug: "publish-gate", title: "The publish gate", soon: true },
      { slug: "automatic-messages", title: "Automatic messages", soon: true },
    ],
  },
  {
    group: "Integrations",
    soon: true,
    pages: [
      { slug: "playwright", title: "Playwright helper", soon: true },
      { slug: "mcp", title: "MCP server", soon: true },
    ],
  },
  {
    group: "Reference",
    pages: [
      { slug: "writes", title: "What it can and can't write" },
      { slug: "private-datasets", title: "Private datasets" },
      { slug: "privacy", title: "Privacy and safety" },
      { slug: "glossary", title: "Glossary" },
      { slug: "faq", title: "FAQ" },
    ],
  },
  {
    group: "Migrations",
    pages: [{ slug: "migrations/node-22", title: "Node 22 and newer" }],
  },
];

/**
 * Pages in this repository that are not on the published site's sidebar. They build and can be
 * linked to, but are not listed.
 */
export const UNLISTED: NavPage[] = [
  { slug: "tools/redirects", title: "Check a redirect list" },
  { slug: "tools/plan", title: "Check a launch plan" },
  { slug: "security", title: "Security" },
  { slug: "changelog", title: "Changelog" },
  { slug: "reference/json-schema", title: "JSON output reference" },
  { slug: "contributing/docs-first", title: "Docs first" },
  { slug: "contributing/adding-a-check", title: "Adding a check" },
  { slug: "contributing/docs-examples", title: "Tested docs examples" },
  { slug: "contributing/migration-guides", title: "Migration guides, Since badges and the feed" },
  { slug: "known-findings", title: "Known findings on our own site" },
  { slug: "guides/ai-assistants", title: "How AI assistants read your site" },
  { slug: "guides/events", title: "How Gaugeline reads a venue calendar" },
  { slug: "guides/schema-rules", title: "Checking structured data against your schema guide" },
  { slug: "guides/languages", title: "Checking language versions" },
  { slug: "guides/facts", title: "Facts that must match everywhere" },
  { slug: "guides/payments", title: "Payment details everywhere" },
  { slug: "guides/emails", title: "Transactional emails: the emails customers get" },
  { slug: "guides/renewals", title: "Renewals: see what lapses before the site goes dark" },
  { slug: "guides/hosting-cost", title: "Hosting cost: find what runs up the bill" },
  { slug: "guides/trackers-on-sensitive-pages", title: "Trackers on sensitive pages" },
  { slug: "guides/published-not-live", title: "Published but not live" },
  { slug: "guides/served-libraries", title: "Served libraries: the old jQuery nobody remembers" },
  { slug: "guides/init", title: "gaugeline init: start from what the site is built on" },
  { slug: "guides/advisory", title: "Advisory check: is my client affected?" },
  { slug: "guides/audit-pack", title: "Audit pack: turn a first run into a proposal" },
  { slug: "guides/agent-skill", title: "The agent skill: let a coding agent run Gaugeline" },
  {
    slug: "guides/migration",
    title: "Migration completeness: nothing from the old site goes missing",
  },
  {
    slug: "guides/handoff",
    title: "Handoff: who owns what, and can the client get in without you",
  },
  { slug: "guides/hidden-text", title: "Hidden text aimed at AI assistants" },
  {
    slug: "guides/script-baseline",
    title: "Script and header baseline: what loads on a payment page, and what changed",
  },
  { slug: "integrations/index", title: "Content systems: one interface for every CMS" },
  // Each adapter's page comes from its entry file (pnpm gen:adapters), so a new adapter does not edit this list.
  ...ADAPTER_PAGES,
  { slug: "connectors/listings", title: "Listings off the site" },
  { slug: "connectors/postgres", title: "A database as a source: Postgres and Supabase" },
  { slug: "sources/shopify", title: "Shopify as a price source" },
  { slug: "sources/square", title: "Square as a price source" },
  { slug: "sources/salesforce-mcp", title: "Salesforce leads through its own MCP server" },
  { slug: "sources/sanity-schema", title: "Content model changes on Sanity" },
  { slug: "guides/data-assertions", title: "Data assertions: a SELECT that should return nothing" },
  {
    slug: "guides/switches-and-availability",
    title: "Switches, sold out and capacity: does the site agree?",
  },
  {
    slug: "guides/data-freshness",
    title: "Data freshness: are the numbers as recent as they should be?",
  },
  { slug: "guides/access-rules", title: "Database access rules, tested from outside" },
  { slug: "guides/nextjs", title: "Next.js sites" },
  { slug: "guides/nuxt", title: "Nuxt sites" },
  { slug: "guides/weekly-digest", title: "The weekly digest" },
  { slug: "guides/click-events", title: "Click events: the tracking plan, checked" },
  { slug: "guides/tag-rules", title: "Tracking rules that point at things that no longer exist" },
  { slug: "guides/printed-links", title: "Printed QR codes and short links" },
  { slug: "guides/navigation", title: "Navigation and footer: what changed" },
  { slug: "guides/page-snapshots", title: "Page snapshots: what each page lost" },
  { slug: "guides/cutover", title: "Cutover: what changed on the day" },
  { slug: "guides/many-sites", title: "Many sites from one file" },
];
