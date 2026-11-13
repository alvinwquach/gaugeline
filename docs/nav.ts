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
      { slug: "config", title: "Config, baselines and suppressions" },
      { slug: "custom-checks", title: "Your own checks" },
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
    pages: [{ slug: "playwright", title: "Playwright helper", soon: true }],
  },
  {
    group: "Reference",
    pages: [
      { slug: "mcp", title: "MCP server" },
      { slug: "mcp-install", title: "Add the MCP server to your assistant" },
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
  { slug: "security/untrusted-content", title: "Text from the sites you check" },
  { slug: "agent-safety", title: "Agents: what they can and cannot do" },
  { slug: "changelog", title: "Changelog" },
  { slug: "reference/json-schema", title: "JSON output reference" },
  { slug: "contributing/docs-first", title: "Docs first" },
  { slug: "contributing/adding-a-check", title: "Adding a check" },
  { slug: "contributing/docs-examples", title: "Tested docs examples" },
  { slug: "contributing/migration-guides", title: "Migration guides, Since badges and the feed" },
  { slug: "known-findings", title: "Known findings on our own site" },
  { slug: "guides/ai-assistants", title: "How AI assistants read your site" },
  { slug: "guides/agent-readiness", title: "How AI agents read your site" },
  { slug: "guides/events", title: "How Gaugeline reads a venue calendar" },
  { slug: "guides/schema-rules", title: "Checking structured data against your schema guide" },
  { slug: "guides/languages", title: "Checking language versions" },
  { slug: "guides/facts", title: "Facts that must match everywhere" },
  { slug: "guides/payments", title: "Payment details everywhere" },
  { slug: "guides/cms-fix-drafts", title: "Fixes as Sanity drafts" },
  { slug: "guides/emails", title: "Transactional emails: the emails customers get" },
  { slug: "guides/renewals", title: "Renewals: see what lapses before the site goes dark" },
  { slug: "guides/hosting-cost", title: "Hosting cost: find what runs up the bill" },
  { slug: "guides/backups", title: "Backups: know when a client's content was last backed up" },
  { slug: "guides/trackers-on-sensitive-pages", title: "Trackers on sensitive pages" },
  { slug: "guides/published-not-live", title: "Published but not live" },
  { slug: "guides/served-libraries", title: "Served libraries: the old jQuery nobody remembers" },
  { slug: "guides/init", title: "gaugeline init: start from what the site is built on" },
  { slug: "guides/deploy-gates", title: "Deploy gates: check a preview before it goes live" },
  { slug: "guides/vercel-gate", title: "Hold a Vercel deploy on Gaugeline's result" },
  { slug: "guides/fix-proposals", title: "Fix proposals: a diff for what lives in your code" },
  {
    slug: "guides/webhook-and-cache-source",
    title: "The publish webhook and the cache, read from your code",
  },
  {
    slug: "guides/image-optimizers",
    title: "Open image optimizers: who can use your site to resize images",
  },
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
  { slug: "guides/out-of-date-copy", title: "Out-of-date copy: dates that have passed" },
  {
    slug: "guides/script-baseline",
    title: "Script and header baseline: what loads on a payment page, and what changed",
  },
  { slug: "integrations/index", title: "Content systems: one interface for every CMS" },
  // Each adapter's page comes from its entry file (pnpm gen:adapters), so a new adapter does not edit this list.
  ...ADAPTER_PAGES,
  { slug: "integrations/recipes/index", title: "Recipes for the generic API adapter" },
  { slug: "integrations/ghost", title: "Ghost: content checks for sites built on Ghost" },
  { slug: "connectors/listings", title: "Listings off the site" },
  { slug: "checks/documents-agree", title: "Documents agree with the site" },
  { slug: "checks/tokens-in-source", title: "Tokens and webhook addresses in your source" },
  { slug: "checks/personal-data-in-source", title: "Visitors' details in analytics and logs" },
  { slug: "connectors/postgres", title: "A database as a source: Postgres and Supabase" },
  { slug: "sources/shopify", title: "Shopify as a price source" },
  { slug: "sources/square", title: "Square as a price source" },
  { slug: "sources/salesforce-mcp", title: "Salesforce leads through its own MCP server" },
  { slug: "sources/supabase-mcp", title: "Supabase through its own MCP server" },
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
  { slug: "guides/source-checks", title: "Checks that read your source" },
  { slug: "guides/noindex-header", title: "Routes your page metadata does not reach" },
  { slug: "guides/host-previews", title: "Preview addresses that search engines can find" },
  { slug: "guides/qwik-solidstart", title: "Qwik and SolidStart sites" },
  { slug: "guides/static-generators", title: "Static site generators" },
  { slug: "guides/angular", title: "Angular sites" },
  { slug: "guides/error-pages", title: "Error pages that answer 200" },
  { slug: "guides/gatsby", title: "Gatsby sites" },
  { slug: "guides/hydrogen", title: "Shopify Hydrogen sites" },
  { slug: "guides/sveltekit", title: "SvelteKit sites" },
  { slug: "guides/astro", title: "Astro sites" },
  { slug: "guides/sanity-images", title: "Sanity images: sizes, crops and duplicates" },
  { slug: "guides/nuxt", title: "Nuxt sites" },
  { slug: "guides/source-maps", title: "Source maps and development tools left on" },
  { slug: "guides/headless-wordpress", title: "Headless WordPress sites" },
  { slug: "guides/remix", title: "Remix and React Router sites" },
  { slug: "guides/weekly-digest", title: "The weekly digest" },
  { slug: "guides/click-events", title: "Click events: the tracking plan, checked" },
  { slug: "guides/tag-rules", title: "Tracking rules that point at things that no longer exist" },
  { slug: "guides/printed-links", title: "Printed QR codes and short links" },
  { slug: "guides/navigation", title: "Navigation and footer: what changed" },
  { slug: "guides/page-snapshots", title: "Page snapshots: what each page lost" },
  { slug: "guides/what-changed", title: "What changed, and who changed it" },
  { slug: "guides/care-plan-receipt", title: "The care-plan receipt" },
  { slug: "guides/mailbox-drafts", title: "Drafts in your own mailbox: Gmail" },
  { slug: "guides/cutover", title: "Cutover: what changed on the day" },
  { slug: "guides/many-sites", title: "Many sites from one file" },
  { slug: "guides/ci-templates", title: "CI templates: GitLab CI, Bitbucket Pipelines, CircleCI" },
  { slug: "hosted/data-model", title: "Hosted: data model and tenancy" },
  { slug: "hosted/api", title: "Hosted: the runs API (v1)" },
  { slug: "hosted/schedules", title: "Hosted: schedules and history" },
  { slug: "hosted/inbox", title: "Hosted: the inbox and approvals" },
  { slug: "hosted/morning-email", title: "Hosted: the morning email" },
  { slug: "hosted/writer", title: "Hosted: applying an approved fix" },
  { slug: "hosted/plan", title: "Hosted app plan" },
  { slug: "hosted/sign-in", title: "Hosted: sign in and the shell" },
  { slug: "hosted/dashboard", title: "Hosted: the dashboard" },
  { slug: "hosted/last-night", title: "Hosted: what happened last night" },
  { slug: "hosted/agencies", title: "Hosted: agencies, client viewers and the weekly update" },
  { slug: "hosted/secrets", title: "Hosted: where secrets live" },
  { slug: "hosted/notifications", title: "Hosted: findings in your Slack and Sentry" },
  { slug: "hosted/chat-approvals", title: "Hosted: approving in Slack, Discord and Teams" },
  { slug: "hosted/agent-registry", title: "Hosted: the agent registry" },
];
