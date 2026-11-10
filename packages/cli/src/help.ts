import { FLAGS, renderHelp } from "./flags.js";

/** Every command the CLI registers. "" is the root command (gaugeline <address>). */
export const COMMANDS = [
  "",
  "launch",
  "view",
  "digest",
  "plan",
  "printed",
  "snapshot",
  "cutover",
  "verify",
  "run",
  "open",
  "assert",
  "ads",
  "tags",
  "delivery",
  "platform",
  "query",
] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Help text, keyed by command. The CLI prints HELP[command] for --help; help text lives here and
 * nowhere else. docs/options.md shows the same text under "Usage", and a test compares the two.
 */
export const HELP: Record<string, string> = {
  "": renderHelp(FLAGS, "check", {
    usage: "gaugeline <address> [options]",
    summary: "Check a website the way search engines and visitors see it. Read-only.",
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  launch: renderHelp(FLAGS, "launch", {
    usage: "gaugeline launch <address> [options]",
    summary: [
      "Run the launch-day checks: links to preview addresses, the share picture, an",
      "indexable staging site, noindex and robots.txt. Read-only.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  view: renderHelp(FLAGS, "view", {
    usage: "gaugeline view <run.json> [options]",
    summary: [
      "Open a saved run (gaugeline <address> --json > run.json) in a terminal view.",
      "Keys: j/k move, enter expand, / filter, d dismiss with a reason, q quit.",
    ].join("\n"),
    footer: "Exit codes: 0 viewed, 2 the file could not be read",
  }),
  plan: renderHelp(FLAGS, "plan", {
    usage: "gaugeline plan <file> [options]",
    summary: [
      "Read a launch plan: any CSV with a URL column. Title tag, H1, keyword and",
      "legacy URL columns are used when present; names are matched loosely.",
    ].join("\n"),
    footer: "Exit codes: 0 read, 2 the plan could not be read",
  }),
  printed: renderHelp(FLAGS, "printed", {
    usage: "gaugeline printed <register.csv> [options]",
    summary: [
      "Check every printed address (QR codes, flyers, short links) in a register still",
      "lands where it should. Columns: url, where, printedOn, expectedDestination.",
    ].join("\n"),
    footer: "Exit codes: 0 every address lands, 1 one needs fixing, 2 could not check",
  }),
  snapshot: renderHelp(FLAGS, "snapshot", {
    usage: "gaugeline snapshot <domain> [options]",
    summary: [
      "Before cutover: record the domain's address, MX, SPF, DKIM and DMARC records,",
      "its certificate's names and expiry, and how the bare domain and www answer.",
      "DKIM selectors come from gaugeline.cutover.json. Lookups only.",
    ].join("\n"),
    footer: "Exit codes: 0 written, 2 could not read the domain or write the file",
  }),
  cutover: renderHelp(FLAGS, "cutover", {
    usage: "gaugeline cutover --before <snapshot.json> [options]",
    summary: [
      "After cutover: read the same domain again and report what changed. A mail or",
      "SPF change is fix first unless gaugeline.cutover.json lists it as expected.",
    ].join("\n"),
    footer: "Exit codes: 0 nothing to fix first, 1 something to fix first, 2 could not check",
  }),
  open: renderHelp(FLAGS, "open", {
    usage: "gaugeline open [address] [options]",
    summary: [
      "Start the app in a browser tab on this computer: it listens on 127.0.0.1 only,",
      "on port 4817 or the next free one, and every request needs the one-time key in",
      "the printed link. Press Ctrl+C to stop; nothing is saved.",
      "--demo starts with example results about invented sites and checks nothing.",
      "--ads <file> starts with an ads export read from that file (and nothing else).",
    ].join("\n"),
    footer: "Exit codes: 0 stopped with Ctrl+C, 2 could not start",
  }),
  run: renderHelp(FLAGS, "run", {
    usage: "gaugeline run --all | --site <name> | --tag <tag> [options]",
    summary: [
      "Check the sites listed in gaugeline.sites.json, one at a time, and save each run",
      "to runs/<site>/<date>.json. Ends with a summary, worst first: new, fixed and",
      "open fix-first findings against each site's last run, or why it couldn't run.",
    ].join("\n"),
    footer: "Exit codes: 0 no new fix-first finding, 1 a site has one, 2 a site couldn't run",
  }),
  verify: renderHelp(FLAGS, "verify", {
    usage: "gaugeline verify <crawl-export.csv> [options]",
    summary: [
      "Read a crawler's export (an Address or URL column, and the issue name if there",
      "is one), set aside assets, data routes and framework prefetch payloads, and",
      "resolve each payload to the page it belongs to. Makes no request.",
    ].join("\n"),
    footer: "Exit codes: 0 read, 2 the export has no address column or could not be read",
  }),
  ads: renderHelp(FLAGS, "ads", {
    usage: "gaugeline ads <export.csv> [options]",
    summary: [
      "Read a Meta Ads Manager or Google Ads export (a link column and an",
      "amount-spent column) and group its ads by the page they send people to: one",
      "line for each page with its number of ads and the spend, highest first. Then",
      "ask each page once, with one ad's campaign tags, and report a page that does",
      "not load, a Shopify product that is sold out, sample text, and the redirect that",
      "drops the tags, with how much of the spend went to those pages. Requests are",
      "GET only, five at a time. It never pauses or edits an ad.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  tags: renderHelp(FLAGS, "tags", {
    usage: "gaugeline tags <link> [options]",
    summary: [
      "Follow an ad link through every redirect and say whether its campaign tags",
      "(utm_*, gclid, fbclid) are still there when the page loads: one line for each",
      "hop, then one verdict. A link with no tags is followed with utm_source=",
      "gaugeline-check and gclid=test. It follows redirects only: it does not run the",
      "page's JavaScript, so a script that rewrites the address after load is out of",
      "scope.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with tags lost, 2 could not follow the link",
  }),
  delivery: renderHelp(FLAGS, "delivery", {
    usage: "gaugeline delivery --paid --sent [--since 7d] [options]",
    summary: [
      "Compare the orders paid in Stripe (STRIPE_API_KEY) with the emails Resend",
      "says it sent (RESEND_API_KEY) in the same window, and report paid orders with",
      "no email: counts and UTC days, never an address, a name or an order. Either",
      "flag alone prints that side's count. Read only: it never sends, resends or",
      "replays anything.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  platform: renderHelp(FLAGS, "platform", {
    usage: "gaugeline platform --webhooks [options]",
    summary: [
      "Read Stripe's webhook endpoints (STRIPE_API_KEY) and the events that were never",
      "delivered, and report an enabled endpoint with events older than an hour that",
      "are still waiting, and an endpoint that is disabled: a host, a count and an age.",
      "Read only: it never replays, retries or resends an event.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  query: renderHelp(FLAGS, "query", {
    usage: "gaugeline query <folder> [options]",
    summary: [
      "Read the GROQ in a repository's .ts, .tsx, .js, .jsx and .mjs files: groq",
      "tagged templates and defineQuery() calls. For each query, print the document",
      "type, the fields it reads, whether its filter leaves drafts out, its",
      "parameters, and the file and line it starts on. A query built at run time, a",
      "file that does not parse and a query with no _type filter are listed as",
      "unreadable. With SANITY_PROJECT_ID set (SANITY_DATASET, and SANITY_TOKEN with",
      "the Viewer role for a private dataset) it also counts the published documents",
      "of each type and how many have each field, one GET for each type, and reports",
      "a field no document has, a type with no documents, a field some documents",
      "lack and a query that does not leave drafts out. Counts only, never content.",
      "With --dupes it also reads the id, slug and title of each published document,",
      "one GET for each type, and names documents of one type that share a slug or a",
      "title. That is the one flag whose output shows text your editors wrote.",
      "With --mutations it also reads the writes in your code (patches, creates,",
      "transactions, webhook handlers) and checks their shapes against the schema in",
      "./schema.json (or --schema <file>). Nothing is sent: the mutations are parsed,",
      "never run, and no request is made for them. It needs no SANITY_PROJECT_ID.",
      "With --graphql it reads the GraphQL in your code (.graphql and .gql files and",
      "gql templates) instead of GROQ, asks the endpoint for its schema with a GET",
      "(the address after --graphql; Sanity's for your project when there is none),",
      "and reports a field the schema does not have. --schema <file> gives the schema",
      "from an SDL or introspection JSON file, and asks nothing. Mutations and",
      "subscriptions are counted and never sent. A token comes from GRAPHQL_TOKEN",
      "(SANITY_TOKEN for Sanity's own address).",
      "Needs TypeScript installed beside it (npx -p gaugeline -p typescript",
      "gaugeline query ./src).",
    ].join("\n"),
    footer: "Exit codes: 0 read, 1 --ci with a fix-first finding, 2 could not run",
  }),
  assert: renderHelp(FLAGS, "assert", {
    usage: "gaugeline assert <id> | --list [options]",
    summary: [
      "Run one data assertion from gaugeline.sources.json: a SELECT that should return",
      "no rows. Any row is a problem, shown with the assertion's evidence columns.",
      "Read only. --list prints the assertions and runs none of them.",
    ].join("\n"),
    footer: "Exit codes: 0 no rows, 1 rows found, 2 could not run or the file is wrong",
  }),
  digest: renderHelp(FLAGS, "digest", {
    usage: "gaugeline digest --runs <folder> [options]",
    summary: [
      "Read a week of saved runs and write what is new, fixed and still open, in plain",
      "English, to gaugeline-digest.md and gaugeline-digest.html. Sends only by email",
      "or webhook, and only when one is configured.",
    ].join("\n"),
    footer: "Exit codes: 0 written, 2 the runs could not be read",
  }),
};
