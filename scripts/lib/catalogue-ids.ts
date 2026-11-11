import {
  CUTOVER_ONLY_CHECKS,
  MIGRATION_CHECKS,
  WEBFLOW_CHECKS,
  CONTENTFUL_CHECKS,
  SQUARESPACE_COMMERCE_CHECKS,
  STRAPI_CHECKS,
  HUBSPOT_CMS_CHECKS,
  AD_LANDING_CHECKS,
  CAMPAIGN_CHECKS,
  DUPLICATE_CHECKS,
  EMAIL_CHECKS,
  PLAN_CHECKS,
  PRESENCE_CHECKS,
  PRICE_CHECKS,
  RENEWALS_CHECKS,
  HANDOFF_CHECKS,
  COST_CHECKS,
  TRACKER_CHECKS,
  PUBLISHED_CHECKS,
  LIBRARY_CHECKS,
  WORDPRESS_CHECKS,
  PRINTED_CHECKS,
  GRAPHQL_CHECKS,
  MUTATION_CHECKS,
  QUERY_CHECKS,
  QUERY_DUPE_CHECKS,
  QUERY_GENERATED_CHECKS,
  QUERY_UNUSED_CHECKS,
  RECEIPT_CHECKS,
  ROUTE_CHECKS,
  WEBHOOK_CHECKS,
  SUBSCRIPTION_CHECKS,
  createPageRegistry,
} from "../../packages/core/src/index.js";

/** Every check the docs list: page checks, plan checks, printed-link checks, price and subscription checks, the query (and its --dupes and --mutations), delivery and webhook checks, the rendered-email checks, the renewals, handoff, cost, tracker, library and WordPress checks and the cutover-only ones. */
export function CATALOGUE_IDS(): string[] {
  const registry = createPageRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  for (const c of PRINTED_CHECKS) registry.register(c);
  for (const c of CAMPAIGN_CHECKS) registry.register(c);
  for (const c of AD_LANDING_CHECKS) registry.register(c);
  for (const c of DUPLICATE_CHECKS) registry.register(c);
  for (const c of EMAIL_CHECKS) registry.register(c);
  for (const c of RENEWALS_CHECKS) registry.register(c);
  for (const c of HANDOFF_CHECKS) registry.register(c);
  for (const c of COST_CHECKS) registry.register(c);
  for (const c of TRACKER_CHECKS) registry.register(c);
  for (const c of PUBLISHED_CHECKS) registry.register(c);
  for (const c of LIBRARY_CHECKS) registry.register(c);
  for (const c of WORDPRESS_CHECKS) registry.register(c);
  for (const c of PRESENCE_CHECKS) registry.register(c);
  for (const c of PRICE_CHECKS) registry.register(c);
  for (const c of SUBSCRIPTION_CHECKS) registry.register(c);
  for (const c of QUERY_CHECKS) registry.register(c);
  for (const c of QUERY_DUPE_CHECKS) registry.register(c);
  for (const c of QUERY_GENERATED_CHECKS) registry.register(c);
  for (const c of QUERY_UNUSED_CHECKS) registry.register(c);
  for (const c of MUTATION_CHECKS) registry.register(c);
  for (const c of GRAPHQL_CHECKS) registry.register(c);
  for (const c of RECEIPT_CHECKS) registry.register(c);
  for (const c of ROUTE_CHECKS) registry.register(c);
  for (const c of WEBHOOK_CHECKS) registry.register(c);
  for (const c of CUTOVER_ONLY_CHECKS) registry.register(c);
  for (const c of MIGRATION_CHECKS) registry.register(c);
  for (const c of WEBFLOW_CHECKS) registry.register(c);
  for (const c of CONTENTFUL_CHECKS) registry.register(c);
  for (const c of SQUARESPACE_COMMERCE_CHECKS) registry.register(c);
  for (const c of STRAPI_CHECKS) registry.register(c);
  for (const c of HUBSPOT_CMS_CHECKS) registry.register(c);
  return registry.all().map((c) => c.id);
}
