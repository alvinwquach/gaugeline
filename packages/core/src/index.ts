export { parseAddress } from "./address.js";
export type { AddressResult } from "./address.js";
export {
  AREAS,
  CheckRegistry,
  POINTS,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SIZES,
  defineCheck,
  isKebabCase,
} from "./model.js";
export type {
  Area,
  Check,
  CheckContext,
  Finding,
  FindingGroup,
  RunExpectations,
  Severity,
  Size,
} from "./model.js";
export { redact } from "./redact.js";
export { runCheckList, sanitiseFinding } from "./runner.js";
export type { RunOutcome } from "./runner.js";
export {
  RESULT_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION as RESULT_SCHEMA,
  SCHEMA_ID_BASE,
  findingSchema,
  buildResult,
  parseResult,
  resultSchema,
  severitySchema,
} from "./result.js";
export type { Result } from "./result.js";
export {
  DEFAULT_USER_AGENT,
  FetchError,
  assertReadOnly,
  createNetworkTransport,
  describeNetworkFailure,
  createFetcher,
} from "./fetcher.js";
export type {
  NetworkTransportOptions,
  Transport,
  TransportRequest,
  FetchErrorReason,
  Fetcher,
  FetcherOptions,
  GetOptions,
  Hop,
  QueryOptions,
} from "./fetcher.js";
export {
  registerQueryAllow,
  registeredQueryAllows,
  resolveQueryAllow,
} from "./fetch/query-registry.js";
export {
  MAX_QUERY_BODY_BYTES,
  QueryRefusedError,
  allowProblems,
  bodyProblem,
  isExactHost,
  isReadOnlyBody,
  isVerified,
  isWriteKey,
  isWriteText,
  matchesPath,
  queryRefusal,
} from "./fetch/read-only-query.js";
export type {
  ConfiguredHost,
  GraphqlQueryShape,
  JsonQueryShape,
  QueryBodyShape,
  ReadOnlyQueryAllow,
  RegisteredQueryAllow,
} from "./fetch/read-only-query.js";
export { Semaphore } from "./semaphore.js";
export { BUDGET_KINDS, LIMITS, createBudget, formatSampleSummary } from "./limits.js";
export type { Budget, BudgetKind, BudgetSummary, BudgetTally, Limits } from "./limits.js";
export { dedupeUrls, isSameSite, sampleUrls, siteOf } from "./sample.js";
export type { SampleItem } from "./sample.js";
export {
  ConfigError,
  CouldNotRunError,
  GaugelineError,
  NetworkError,
  errorCodes,
  isGaugelineError,
} from "./errors.js";
export type { ErrorOptions } from "./errors.js";
export { exitCodeFor } from "./outcome.js";
export type { Outcome } from "./outcome.js";
export { buildSnapshot, jsonLdNodes } from "./snapshot.js";
export type { PageSnapshot } from "./snapshot.js";
export { charsetFromContentType, decodeBody, sniffMetaCharset } from "./charset.js";
export { compareAddresses, normaliseText, normaliseUrl, sameText } from "./normalise.js";
export type { AddressComparison, AddressDifference, CompareOptions } from "./normalise.js";
export { runChecks } from "./run.js";
export { classifyHop, describeRefusal } from "./refusal.js";
export type { HopOutcome } from "./refusal.js";
export type { RunOptions, RunResult } from "./run.js";
export {
  PAGE_CHECKS,
  THIN_HTML_MIN_WORDS,
  IMAGE_ABSURD_WIDTH,
  IMAGE_HEAVY_BYTES,
  alternateHost,
  createPageRegistry,
  imageRefs,
  parseSrcset,
  sampleImages,
} from "./checks/index.js";
export type { ImageRef, ImageSample } from "./checks/index.js";
export { progressText } from "./progress.js";
export type { ProgressEvent, ProgressSink, RequestInfo } from "./progress.js";
export { checkSite } from "./site.js";
export { getOrNull, probe } from "./probe.js";
export { lazyPages, samplePages } from "./pages.js";
export {
  ISO_639_1,
  isLanguageTag,
  languageMap,
  languageRulesSchema,
  lazyLanguageGroup,
  pageKey,
  pagePrices,
  parsePrice,
  primaryLanguage,
  readLanguageGroup,
  twinUrl,
} from "./languages.js";
export type {
  LanguageGroup,
  LanguageOptions,
  LanguageRules,
  LanguageVersion,
} from "./languages.js";
export type { PagesOptions } from "./pages.js";
export {
  flattenSchema,
  globToRegex,
  matchTemplate,
  normaliseId,
  schemaRulesSchema,
} from "./schema-rules.js";
export type { FlatSchema, SchemaNode, SchemaRules } from "./schema-rules.js";
export { calendarUrl, isIcs, lazyCalendars, readCalendars } from "./calendars.js";
export type { CalendarOptions, CalendarRead } from "./calendars.js";
export { contentLine, parseIcs, parseIcsTime, unescapeText, unfold } from "./ics/parse.js";
export type { IcsEvent, IcsFile, IcsTime } from "./ics/parse.js";
export { EXPAND_DAYS, expandCalendar, nextAfter, onDate, parseRule } from "./ics/expand.js";
export type { Expansion, Occurrence } from "./ics/expand.js";
export { isTimeZone, localDate, localTime, offsetAt, wallTimeAt, zonedToUtc } from "./ics/time.js";
export type { WallTime } from "./ics/time.js";
export {
  appRefs,
  appleLookupUrl,
  appleRef,
  bannerAppId,
  googleListingUrl,
  googleRef,
  lazyAppLookups,
  lookupApps,
  playTitle,
} from "./apps.js";
export type { AppLookup, AppLookupOptions, AppRef } from "./apps.js";
export { lazyLinkSample, linkCandidates, sampleLinks } from "./links.js";
export type { LinkResult, LinkSample, LinkSampleOptions } from "./links.js";
export type { SiteCheck, SiteCheckOptions } from "./site.js";
export { buildSiteContext, lazySiteContext, parseFeedLinks, parseSitemap } from "./site-context.js";
export type {
  FeedRead,
  LlmsRead,
  RobotsState,
  SiteContext,
  SiteContextOptions,
  SitemapKind,
  SitemapRead,
} from "./site-context.js";
export {
  decidingRule,
  hasOwnGroup,
  isAllowed,
  parseRobots,
  patternMatches,
  rulesFor,
} from "./robots.js";
export { AI_AGENTS, AI_AGENTS_MAX_AGE_DAYS, staleAgents } from "./ai-agents.js";
export type { AiAgent, AiPurpose } from "./ai-agents.js";
export { llmsFacts, parseLlmsTxt } from "./llms.js";
export type { LlmsFile, LlmsLink } from "./llms.js";
export { addressParts, businessFromJsonLd } from "./facts/business.js";
export { findFact } from "./facts/extract.js";
export { factSchema, factsConfigSchema } from "./facts/types.js";
export { documentsConfigSchema } from "./documents/config.js";
export type { DocumentsConfig } from "./documents/config.js";
export { parseItemLines } from "./documents/lines.js";
export type { DocItem } from "./documents/lines.js";
export { referenceFromGroups } from "./documents/reference.js";
export { INSTALL_HINT, loadDocumentReader } from "./documents/types.js";
export type {
  DocumentReader,
  DocumentText,
  DocumentsContext,
  ReferenceItem,
} from "./documents/types.js";
export { DOCUMENT_CHECKS } from "./checks/documents.js";
export type { Fact, FactsConfig, Occurrence as FactOccurrence } from "./facts/types.js";
export { ANCHOR_WINDOW, PAYMENT_RULES, configValue, extractPayments } from "./payments/extract.js";
export { DETECTORS, findLeaks, redact as redactSecret } from "./checks/leaks/detectors.js";
export type { Detector, Leak } from "./checks/leaks/detectors.js";
export { PRIVATE_TYPE_WORDS, isPrivateType } from "./checks/leaks/private-types.js";
export { SANITY_QUERY, readDataset, sanityQueryUrl, sanityRefs } from "./sanity.js";
export type { DatasetRead, SanityRef } from "./sanity.js";
export { readScripts } from "./scripts.js";
export {
  ASSERTION_CHECKS,
  EMAIL_PRESET,
  LAUNCH_PRESET,
  FRESHNESS_CHECKS,
  MODEL_CHECKS,
  LISTING_CHECKS,
  CRM_CHECKS,
  PROBING_CHECKS,
  SANITY_IMAGE_CHECKS,
  SWITCH_CHECKS,
} from "./presets.js";
export {
  SANITY_ASSET_CAP,
  USES_BATCH,
  SIZE_BATCH,
  assetDocumentId,
  readSanityImages,
  sizeQuery,
  usesQuery,
} from "./sanity-images/read.js";
export type { AssetRead, SanityImageRead, StudioUse } from "./sanity-images/read.js";
export {
  CHANNELS,
  EMAIL_ENV,
  EMAIL_FROM_ENV,
  NOTIFY_ON,
  RESEND_KEY_ENV,
  notifyAll,
  resolveTargets,
  shouldNotify,
} from "./notify/index.js";
export type { Channel, ChannelId, EmailOptions, NotifyOn, Sent, Target } from "./notify/index.js";
export {
  EMAIL_CUT_FINDINGS,
  EMAIL_MAX_BYTES,
  ONBOARDING_FROM,
  RESEND_EMAILS_URL,
  buildEmail,
  emailSubject,
  parseAddresses,
  postEmail,
  sendEmail,
} from "./notify/email.js";
export {
  DIGEST_DAYS,
  buildDigest,
  daysBetween,
  digestHtml,
  digestMarkdown,
  findingKey,
  safeEvidence,
  shortDate,
  stripQuery,
  verdict as digestVerdict,
} from "./digest.js";
export type { Digest, DigestItem } from "./digest.js";
export {
  comparePrices,
  parseAmount,
  pricesDisagree,
  readPrices,
  shopifyProductJs,
} from "./price.js";
export type { PriceDisagreement, PriceReading } from "./price.js";
export { COLUMN_ALIASES, normaliseHeader, parseCsv, readPlan } from "./plan/read.js";
export type { ColumnMap, Plan, PlanField, PlanRow } from "./plan/read.js";
export { formatDate, readWorkbook } from "./plan/workbook.js";
export {
  applyLegacy,
  classify as classifyLegacy,
  extractLegacy,
  legacyHints,
  legacyReviewCsv,
  pathsIn,
  splitSentences,
} from "./plan/legacy-notes.js";
export type { LegacyKind, LegacyMention } from "./plan/legacy-notes.js";
export {
  PLAN_CHECKS,
  createPlanRegistry,
  planLegacyUnresolved,
  planSelfChecks,
  planSlugMisspelling,
  planKeywordCannibalisation,
  planKeywordOverlap,
  planBuiltChecks,
  planRedirectChecks,
  planRedirectConflict,
  planUncoveredPage,
  planRankUnknownAddress,
  planNavChecks,
  NAV_CHECK_IDS,
} from "./plan/checks.js";
export { BUILT_CHECK_IDS, BUILT_TITLES, canonicalIsThisPage, checkBuilt } from "./plan/built.js";
export type { BuiltOptions, BuiltResult } from "./plan/built.js";
export {
  PREVIEW_AUTH_ENV,
  SECRET_FLAGS,
  authHeaders,
  previewAuth,
  protectionMessage,
  protectionOf,
  protectionPage,
} from "./fetch/preview-auth.js";
export type { PreviewAuth, Protection } from "./fetch/preview-auth.js";
export { fingerprint, stableEvidence } from "./fingerprint.js";
export {
  CHECK_MODES,
  FINDINGS_BASELINE_SCHEMA,
  applySuppressions,
  buildFindingsBaseline,
  dayOf,
  diffFindingsBaseline,
  isBlocking,
  isCalendarDate,
  offIds,
  parseConfig,
  parseFindingsBaseline,
  registerCustomChecks,
  sandboxCustomCheck,
} from "./config/index.js";
export type {
  CheckMode,
  Config,
  CustomCheckContext,
  FindingsBaseline,
  FindingsBaselineEntry,
  FindingsBaselineMigration,
  ParseFindingsBaselineOptions,
  Suppression,
  SuppressionResult,
} from "./config/index.js";
export {
  PLAN_STATE_SCHEMA,
  compare as comparePlanProgress,
  planHash,
  progressLine,
  readPlanState,
  rowsMatching,
} from "./plan/progress.js";
export type { PlanProgress, PlanState, ReadState as PlanStateRead } from "./plan/progress.js";
export {
  REDIRECT_CHECK_IDS,
  REDIRECT_TITLES,
  checkRedirects,
  classify as classifyRedirect,
  legacyClaims,
  legacyPath,
  redirectConflicts,
  splitLegacy,
} from "./plan/redirects.js";
export type {
  RedirectCheckId,
  RedirectOptions,
  RedirectResult,
  RedirectVerdict,
} from "./plan/redirects.js";
export { checkKeywords, keywordKey, secondaryTerms } from "./plan/keywords.js";
export { ANNOTATION_HEADER, annotate, byLine } from "./plan/annotate.js";
export { addressKey, groupBy, textKey } from "./plan/keys.js";
export { SELF_RULES, checkPlan, runSelfRule } from "./plan/self.js";
export { LONG_WORD, MIN_WORD, checkSlugs, misspelling, sameStem } from "./plan/slug.js";
export { damerau } from "./text/distance.js";
export { SPELLING_VARIANTS, isSpellingVariant } from "./text/variants.js";
export type { SelfRule } from "./plan/self.js";
export type { PlanCheckInput } from "./plan/checks.js";
export type { Sheet, Workbook } from "./plan/workbook.js";
export type { BuiltEmail, EmailSettings } from "./notify/email.js";
export { discordPayload, slackPayload, webhookPayload } from "./notify/payloads.js";
export { NOTIFY_TIMEOUT_MS, postJson, providerMessage, safeTarget } from "./notify/post.js";
export type { NameResolver } from "./notify/post.js";
export {
  checkDestination,
  DESTINATION_KINDS,
  RETRY_DELAYS_MS,
  sendWithRetry,
} from "./notify/destinations.js";
export type {
  Delivered,
  Destination as NotifyDestination,
  DestinationKind,
} from "./notify/destinations.js";
export { slackChangesPayload } from "./notify/slack.js";
export {
  APPROVE_ACTION,
  checkSlackResponseUrl,
  DECLINE_ACTION,
  EDIT_ACTION,
  slackApprovalMessage,
  slackDecidedMessage,
  slackPrivateReply,
} from "./notify/slack-approval.js";
export {
  checkDiscordWebhook,
  DISCORD_ACK,
  DISCORD_APPROVE,
  DISCORD_DECLINE,
  DISCORD_PONG,
  discordApprovalMessage,
  discordDecidedData,
  discordPrivateReply,
  discordUpdateMessage,
} from "./notify/discord-approval.js";
export type { DiscordEmbed, DiscordMessage } from "./notify/discord-approval.js";
export type {
  ApprovalRequest,
  Decided,
  SlackApprovalMessage,
  SlackBlock,
  SlackReply,
} from "./notify/slack-approval.js";
export type { ChangedFinding, SiteChanges } from "./notify/slack.js";
export { parseSentryDsn, sentryEvent } from "./notify/sentry.js";
export type { SentryDsn, SentryEvent } from "./notify/sentry.js";
export {
  UPLOAD_TIMEOUT_MS,
  UPLOAD_TOKEN_ENV,
  UPLOAD_URL_ENV,
  uploadKey,
  uploadResult,
} from "./notify/upload.js";
export type { UploadOutcome } from "./notify/upload.js";
export { escapeHtml, renderLookedRight, renderReport, renderSampled } from "./report/html.js";
export type { ReportInput } from "./report/html.js";
export { EVIDENCE_LIMIT, formatJunit, formatSarif } from "./report/formats.js";
export type { FormatOptions, SuppressedFinding } from "./report/formats.js";
export {
  buildBrief,
  costRange,
  escapeMarkdown,
  formatCurrency,
  hoursRange,
  renderBriefMarkdown,
} from "./report/brief.js";
export type { BriefOptions } from "./report/brief.js";
export {
  BRIEF_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION as BRIEF_SCHEMA,
  briefItemSchema,
  briefSchema,
  parseBrief,
} from "./report/brief-schema.js";
export type { Brief, BriefEvidencePart, BriefItem, BriefNotSized } from "./report/brief-schema.js";
export {
  COMING_UP_DAYS,
  RECEIPT_GROUPS,
  buildReceipt,
  monthName,
  parseReceiptMonth,
  previousMonth,
  receiptGroupOf,
  receiptJson,
  receiptMarkdown,
  receiptPrintable,
} from "./receipt/index.js";
export type {
  ClientReport,
  ComingUp,
  Receipt,
  ReceiptGroup,
  ReceiptGroupId,
  CareReceiptInput,
  ReceiptItem,
  ReceiptMonth,
  ReceiptRun,
} from "./receipt/index.js";
export {
  RUN_SNAPSHOT_SCHEMA,
  buildRunSnapshot,
  diffSnapshots,
  parseMinorUnits,
  providerFor,
} from "./run-snapshot.js";
export type { RunSnapshot, SnapshotChange } from "./run-snapshot.js";
export { NEXT_RENDERED_NOTE, isNextSite, readCache } from "./next/detect.js";
export type { CacheRead } from "./next/detect.js";
export { isSveltekitSite, dataAddress as sveltekitDataAddress } from "./sveltekit/detect.js";
export { isFrameworkUrl } from "./next/framework-urls.js";
export { NUXT_RENDERED_NOTE, isNuxtSite } from "./nuxt/detect.js";
export { isNuxtFrameworkUrl } from "./nuxt/framework-urls.js";
export { frameworkLinks } from "./links.js";
export { consentConfigSchema } from "./consent.js";
export { imagesConfigSchema } from "./images/config.js";
export type { ImageSettings, ImagesConfig } from "./images/config.js";
export type { ConsentConfig } from "./consent.js";
export { staleDatesConfigSchema } from "./stale-dates/config.js";
export type { StaleDatesConfig } from "./stale-dates/config.js";
export { hiddenConfigSchema, isHidden, matchesGlob, overdue } from "./hidden.js";
export type { HiddenConfig, HiddenSection } from "./hidden.js";
export { studioConfigSchema } from "./studio.js";
export type { StudioConfig } from "./studio.js";
export { eventRuleSchema, eventsConfigSchema, REGIONS } from "./events/types.js";
export { readEventsCsv } from "./events/spec-csv.js";
export type { EventRule, EventsConfig, Region } from "./events/types.js";
export {
  EVENT_WAIT_MS,
  MAX_EVENT_TARGETS,
  NO_OBSERVER,
  asSent,
  clickTargets,
  judgeClick,
  observedEvents,
  recordedObserver,
} from "./events/observe.js";
export type {
  ClickTarget,
  ClickVerdict,
  EventObserver,
  EventsRead,
  ObserveResult,
  ObservedClick,
} from "./events/observe.js";
export {
  ALL_PAGES_TRIGGER_ID,
  readCondition,
  readContainer,
  tagsConfigSchema,
} from "./tags/read-container.js";
export type {
  TagCondition,
  TagContainer,
  TagEntry,
  TagOperator,
  TagSubject,
  TagTrigger,
  TagsConfig,
  TriggerKind,
} from "./tags/read-container.js";
export {
  analyseTags,
  duplicateTags,
  formatTagSummary,
  summarise as summariseTags,
} from "./tags/analyse.js";
export type {
  AnalyseInput,
  DuplicateTags,
  TagAnalysis,
  TagSummary,
  TriggerVerdict,
} from "./tags/analyse.js";
export { findPagination, mainTextFingerprint, pageNumber } from "./checks/listing/pagination.js";
export type { Pagination } from "./checks/listing/pagination.js";
export { TEMP_HOST_SUFFIXES, isTemporaryHost } from "./checks/launch/hosts.js";
export {
  DnsLookupError,
  createDnsReader,
  dnsName,
  isReservedName,
  registrableDomain,
} from "./dns.js";
export type { DnsReader, DnsReaderOptions, DnsResolver, MxRecord } from "./dns.js";
export { accessConfigSchema, resolveAccess } from "./access/types.js";
export type { AccessConfig, AccessSettings } from "./access/types.js";
export { classify as classifyAccessRead, probeAccess } from "./access/probe.js";
export type { AccessRead, ProbedTable, ReadState, ScopedRead } from "./access/probe.js";
export type { ScriptRead } from "./scripts.js";
export type { PaymentRule } from "./payments/extract.js";
export { KIND_NAME, PAYMENT_KINDS, paymentSchema, paymentsConfigSchema } from "./payments/types.js";
export type { Payment, PaymentDetail, PaymentKind, PaymentsConfig } from "./payments/types.js";
export type { BusinessFacts } from "./facts/business.js";
export {
  DAYS,
  hoursDisagree,
  normaliseAmount,
  normaliseHandle,
  normalisePhone,
  parseDay,
  parseDays,
  parseHoursText,
  parseTime,
  parseTimeRange,
} from "./facts/normalise.js";
export type { Day, Hours } from "./facts/normalise.js";
export type { RobotsFile, RobotsGroup, RobotsRule } from "./robots.js";
export { blockedRange, isBlockedAddress } from "./addresses.js";
export type { BlockedRange } from "./addresses.js";
export { send, systemResolver } from "./transport.js";
export type { ResolvedAddress, Resolver, TransportResponse } from "./transport.js";
export {
  KEY_PATTERNS,
  findKeys,
  keyPatterns,
  secretsIn,
  secretsInValue,
  stringsOf,
} from "./secrets.js";
export type { KeyPattern } from "./secrets.js";
export { catalogue } from "./catalogue.js";
export type { CatalogueEntry } from "./catalogue.js";
export { DEPRECATED, deprecate, resetDeprecations } from "./deprecate.js";
export type { Deprecation } from "./deprecate.js";
export { EXIT_CODES, PUBLIC_ENV_VARS, publicSurface } from "./public-surface.js";
export type { PublicSurface } from "./public-surface.js";
export { readQr } from "./printed/qr.js";
export type { QrRead } from "./printed/qr.js";
export { decodePng, PngError } from "./printed/png.js";
export type { Rgba } from "./printed/png.js";
export { PRINTED_COLUMNS, readRegister, registerAdditions } from "./printed/register.js";
export type { PrintedField, PrintedRow } from "./printed/register.js";
export {
  DEFAULT_TAG_PREFIXES,
  PRINTED_CHECK_IDS,
  PRINTED_TITLES,
  byAddress,
  checkPrinted,
  classifyPrinted,
} from "./printed/check.js";
export type {
  PrintedCheckId,
  PrintedOptions,
  PrintedResult,
  PrintedVerdict,
} from "./printed/check.js";
export { PRINTED_CHECKS, createPrintedRegistry } from "./printed/checks.js";
export {
  CUTOVER_ONLY_CHECKS,
  changed as cutoverChanged,
  createCutoverRegistry,
} from "./checks/cutover.js";
export type { CutoverCheckInput } from "./checks/cutover.js";
export { expiryFinding } from "./checks/certificate-expiring.js";
export {
  certificateOf,
  covers as certificateCovers,
  daysLeft,
  EXPIRY_DAYS,
  SOON_DAYS,
} from "./dns/certificate.js";
export type { Certificate } from "./dns/certificate.js";
export { isSpfRecord, parseDmarc, parseSpf, readDomainRecords } from "./dns/records.js";
export type { DomainRecords, Spf } from "./dns/records.js";
export {
  CUTOVER_RECORDS,
  cutoverConfigSchema,
  takeCutoverSnapshot,
} from "./dns/cutover-snapshot.js";
export type {
  CutoverConfig,
  CutoverRecord,
  CutoverSnapshot,
  CutoverSnapshotOptions,
  HostBehaviour,
} from "./dns/cutover-snapshot.js";
export type { PrintedCheckInput } from "./printed/checks.js";
export {
  checkCoverage,
  coverageKey,
  detectLiveFormat,
  globToRegExp,
  ignored as ignoredLive,
  readLive,
} from "./plan/coverage.js";
export type {
  CoverageOptions,
  CoverageResult,
  LiveFormat,
  LiveRead,
  LiveUrl,
} from "./plan/coverage.js";
export {
  RANK_COLUMNS,
  compareWorth,
  parseNumber,
  rankUncovered,
  rankUnknown,
  readRankExport,
} from "./plan/worth.js";
export type { RankExport, Ranked, Worth } from "./plan/worth.js";
export {
  NAV_STOP_WORDS,
  NAV_TITLES,
  checkNav,
  distinctiveWords,
  labelKey,
  navLabelRows,
  navSheets,
  navTabLine,
  readNav,
  readNavTab,
} from "./plan/nav.js";
export type { NavCheckId, NavItem, NavLabelRow, NavResult, NavTab } from "./plan/nav.js";
export { destinationKey, navRulesSchema, readRegions } from "./nav/read-regions.js";
export type { NavEntry, NavRegion, NavRules, PageNav } from "./nav/read-regions.js";
export { buildBaseline, readBaseline, SECURITY_HEADERS } from "./script-baseline/inventory.js";
export type { Directives, ScriptBaseline } from "./script-baseline/inventory.js";
export { diffBaselines } from "./script-baseline/diff.js";
export type { BaselineChange } from "./script-baseline/diff.js";
export { KNOWN_BAD_HOSTS, knownBadHost } from "./script-baseline/known-bad.js";
export type { KnownBadHost } from "./script-baseline/known-bad.js";
export { COMPARED, diffNav, inboundLinks, orphans } from "./nav/graph.js";
export type { NavChange, NavChangeKind } from "./nav/graph.js";
export { buildContentSnapshot, contentKey } from "./snapshot/page-snapshot.js";
export type { ContentSnapshot } from "./snapshot/page-snapshot.js";
export { mainContent } from "./snapshot/main-content.js";
export type { MainContent } from "./snapshot/main-content.js";
export {
  contentGains,
  LOST_SHARE,
  lostContent,
  lostItems,
  lostTypes,
  pagesConfigSchema,
} from "./snapshot/compare.js";
export type { ContentNow, PagesConfig } from "./snapshot/compare.js";
export { readNow } from "./snapshot/now.js";
export { WATCH_DAYS, newSince, watchDay, watchLine, watchSummary } from "./plan/watch.js";
export type { WatchDay } from "./plan/watch.js";
export {
  classify,
  createCrawlReader,
  createSummariser,
  detectColumns,
  formatSummary,
  NoAddressColumnError,
  pageKey as crawlPageKey,
  readCrawlExport,
  ROW_KINDS,
  summarise,
  summariseStream,
} from "./verify/classify.js";
export type {
  Classified,
  CrawlColumns,
  CrawlExport,
  CrawlRow,
  CrawlSummary,
  Framework,
  RowKind,
} from "./verify/classify.js";
export { createCsvStream } from "./verify/csv-stream.js";
export type { CsvRecord, CsvStream } from "./verify/csv-stream.js";
export {
  formatRecheck,
  judge as judgeCrawlerView,
  parseVary,
  recheck,
  RSC_HEADER,
  selectPages,
  varyCoversRsc,
  viewPage,
} from "./verify/recheck.js";
export type { CrawlerView, PageToCheck, RecheckResult, Unread } from "./verify/recheck.js";
export {
  ORIGIN_SECRETS,
  siteEntrySchema,
  siteEnv,
  sitesFileSchema,
} from "./config/sites-schema.js";
export type { SiteEntry, SitesFile } from "./config/sites-schema.js";
export {
  LIVE_LIMIT,
  lintPlan,
  lintRedirects,
  parsePlanSheet,
  parseRedirectList,
  PLAN_COMMAND,
  REDIRECT_COMMAND,
  ShapeError,
} from "./tools/lint.js";
export type { Issue, ListRow, PlanRule, PlanToolRow, RedirectRule } from "./tools/lint.js";
export {
  createLimiter,
  domainFetcher,
  handleCheckRedirects,
  liveCheck,
  liveDomain,
  LiveRefusal,
} from "./tools/check-redirects.js";
export type { LiveResult, LiveRow } from "./tools/check-redirects.js";
export { classifyAddress, createAddressPolicy, isTarget } from "./net/address-policy.js";
export type { AddressClass } from "./net/address-policy.js";
export { REQUEST_KINDS, requestRows } from "./request-log.js";
export type { RequestKind, RequestRow } from "./request-log.js";
export {
  MAX_SAVED_PAGE_BYTES,
  MAX_SAVED_REQUESTS,
  REQUESTS_FILE_NOTICE,
  REQUESTS_FILE_SCHEMA_VERSION,
  buildRequestsFile,
  parseRequestsFile,
  requestsFileSchema,
  requestsFileSchemaV1,
} from "./requests-file.js";
export type { RequestsFile, RequestsFileCaps, RequestsFileV1 } from "./requests-file.js";
export { leaksView, MAX_PREVIEWS } from "./leaks-view.js";
export type { DatasetView, LeaksView, ScriptView } from "./leaks-view.js";
export { pageData } from "./run-view.js";
export type { PageData, StructuredBlock } from "./run-view.js";
export {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  PRINTFUL_API_TOKEN,
  PRINTFUL_DETAIL_CONCURRENCY,
  PRINTFUL_ENV_VARS,
  PRINTFUL_MAX_DETAILS,
  PRINTFUL_MAX_LIST_PAGES,
  PRINTFUL_MAX_RETRY_SECONDS,
  PRINTFUL_PAGE_SIZE,
  PRINTFUL_STORE_ID,
  REDACTED,
  connectorGet,
  DATABASE_MAX_ROWS,
  DEFAULT_DATASET,
  DEFAULT_DENIED_FUNCTIONS,
  DEFAULT_POSTGRES_ENV,
  DEFAULT_PRODUCTS_QUERY,
  DEFAULT_SUPABASE_ENV,
  DEFAULT_SHOPIFY_API_VERSION,
  DEFAULT_SUPABASE_KEY_ENV,
  DatabaseError,
  SANITY_ENV_VARS,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_API_VERSION,
  SHOPIFY_ENV_VARS,
  SHOPIFY_MAX_PAGES,
  SHOPIFY_OPTIONAL_ENV_VARS,
  SHOPIFY_PAGE_SIZE,
  SHOPIFY_SHOP_DOMAIN,
  SQUARE_ACCESS_TOKEN,
  SQUARE_ENV_VARS,
  SQUARE_MAX_PAGES,
  STRIPE_API_KEY,
  STRIPE_ENV_VARS,
  STRIPE_MAX_PAGES,
  STRIPE_PAGE_SIZE,
  assertionSchema,
  checkSupabaseKey,
  buildStripeProducts,
  classifyStatement,
  classifyStripeKey,
  createPrintfulConnector,
  createRedactor,
  createShopifyConnector,
  createSquareConnector,
  createStripeConnector,
  databaseConnector,
  databaseEnvVars,
  factsFromResult,
  findTestPublishableKeys,
  guardStripeKey,
  lazyDatabases,
  mapPrintfulVariant,
  mapShopifyProduct,
  mapShopifyVariant,
  mapSquareItem,
  mapSquareVariation,
  nextPageInfo,
  readDatabases,
  sourcesConfigSchema,
  freezeEnv,
  isConfigured,
  missingVars,
  parseProducts,
  printfulConnector,
  productsUrl,
  retailToMinor,
  retryAfterSeconds,
  runConnectors,
  sanityConnector,
  sanityTypeCounts,
  shopifyAvailability,
  shopifyConnector,
  shopifyHost,
  shopifyPrice,
  squareConnector,
  squarePrice,
  stripeConnector,
} from "./connectors/index.js";
export type {
  Assertion,
  CatalogueItem,
  CatalogueVariant,
  Connector,
  ConnectorNotice,
  ConnectorRequest,
  ConnectorRun,
  DatabaseConnector,
  DatabaseQueryResult,
  DatabasesRead,
  DatabasesSettings,
  Env,
  FactMapping,
  PrintfulConnectorOptions,
  PrintfulProduct,
  PrintfulVariant,
  RefusalReason,
  RunConnectorsOptions,
  SanityConnector,
  SanityProduct,
  ShopifyConnectorOptions,
  ShopifyProduct,
  SourceConfig,
  SourcesConfig,
  SquareConnectorOptions,
  SquareItem,
  StripeConnectorOptions,
  StripeKeyKind,
  StripePrice,
  StripeRecurring,
  StripeProduct,
  Verdict,
} from "./connectors/index.js";
export {
  CELL_CHARS,
  EVIDENCE_ROWS,
  assertionsOf,
  cellText,
  describeAssertion,
  lazyAssertions,
  readAssertions,
} from "./assertions/index.js";
export type {
  AssertionResult,
  AssertionStatus,
  AssertionsRead,
  AssertionsSettings,
  Placed as PlacedAssertion,
} from "./assertions/index.js";
export {
  MAX_STATE_PAGES,
  cacheNote,
  capacityValue,
  createStatePages,
  lazySwitches,
  parseSourceRef,
  readSwitches,
  referenceProblems,
  resolveQuery,
  scopePaths,
  switchValue,
  switchesConfigSchema,
  usesSanity,
} from "./switches/index.js";
export type {
  AvailabilityResult,
  CapacityResult,
  StatePage,
  StatePages,
  SwitchDatabases,
  SwitchResult,
  SwitchesConfig,
  SwitchesDeps,
  SwitchesRead,
  SwitchesSettings,
} from "./switches/index.js";
export { sourcesRedactor } from "./assertions/index.js";
export {
  MAX_LISTING_PAGES,
  MAX_MODEL_RULES,
  filterProblem,
  modelConfigSchema,
  pathMatches,
} from "./content-model/config.js";
export type { ModelConfig, ModelDependent, ModelListing } from "./content-model/config.js";
export { createContentModel } from "./content-model/read.js";
export type { ContentModel, ModelSettings } from "./content-model/read.js";
export { findRawRefs } from "./content-model/raw-refs.js";
export type { RawRef, RawRefKind } from "./content-model/raw-refs.js";
export { readListing } from "./content-model/listing.js";
export type { ListingRead } from "./content-model/listing.js";
export {
  countType,
  idsNotIn,
  modelOf,
  orphanCandidates,
  readModelSchema,
  tallyFields,
} from "./sources/sanity-schema.js";
export type { FieldTallies, MissingIds, Tally, TypeModel } from "./sources/sanity-schema.js";
export {
  MAX_FORECAST_ITEMS,
  MAX_SPOT_CHECKS,
  createFreshness,
  describeMonths,
  exactPages,
  freshnessConfigSchema,
  freshnessReferenceProblems,
  freshnessSources,
  isActive,
  matchesPage,
  numberFrom,
  parseDuration,
  parseMoment,
  parseTolerance,
  usesSanity as freshnessUsesSanity,
  within,
} from "./freshness/index.js";
export type {
  FreshnessConfig,
  FreshnessRule,
  FreshnessSettings,
  Freshness,
  Moment,
} from "./freshness/index.js";
export {
  adDestinationKey,
  formatDestinationLines,
  groupByDestination,
  readAdsExport,
  spendByCurrency,
} from "./ads/export.js";
export type { AdRow, AdsExport, CurrencySpend, Destination } from "./ads/export.js";
export { checkAdLandingPages } from "./ads/check.js";
export type { AdsCheckOutcome } from "./ads/check.js";
export {
  CAMPAIGN_KEYS,
  PROBE_TAGS,
  campaignTags,
  describeTrail,
  isCampaignKey,
  tagSurvival,
  withCampaignTags,
} from "./ads/tags.js";
export type { TagLoss, TagProbe, TagSurvival, TrailText } from "./ads/tags.js";
export {
  CAMPAIGN_CHECKS,
  campaignFieldsLost,
  createCampaignRegistry,
} from "./checks/campaign-fields-lost.js";
export type { CampaignTagsInput } from "./checks/campaign-fields-lost.js";
export { AD_LANDING_CHECKS, createAdsRegistry } from "./checks/ad-landing.js";
export { adDeadPage } from "./checks/ad-dead-page.js";
export type { AdPagesInput } from "./checks/ad-dead-page.js";
export { adSoldOut } from "./checks/ad-sold-out.js";
export {
  classifyLanding,
  parseAvailability,
  readStock,
  shopifyProduct,
  summarise as summariseAds,
  summarySentence,
} from "./ads/landing.js";
export type {
  AdsSummary,
  Availability,
  DestinationSummary,
  Landing,
  ProductPage,
  StockRead,
} from "./ads/landing.js";
export {
  FORM_JS_NOTE,
  FORM_PROVIDER_IDS,
  PROVIDERS as FORM_PROVIDERS,
  detectForms,
  formNotes,
} from "./forms/providers.js";
export type {
  FormProvider,
  FormProviderId,
  FormSighting,
  SightingProvider,
} from "./forms/providers.js";
export { formatMoney, minorExponent, toMinor } from "./products/money.js";
export type { Money } from "./products/money.js";
export {
  PRICE_CHECKS,
  PRICE_CHECK_IDS,
  createPriceRegistry,
  priceMismatch,
  priceStoredTwice,
  printfulPrice,
  stripeNoPrice,
} from "./checks/prices.js";
export type { PriceCheckId, PriceCheckInput } from "./checks/prices.js";
export {
  DUPLICATE_CHECKS,
  DUPLICATE_CHECK_IDS,
  DUPLICATE_LIST_MAX,
  createDuplicatesRegistry,
  duplicatePrintful,
  duplicateSanity,
  duplicateStripe,
  duplicatesInput,
  findDuplicates,
} from "./checks/product-duplicates.js";
export type { DuplicateCheckId, ProductDuplicatesInput } from "./checks/product-duplicates.js";
export {
  PRESENCE_CHECKS,
  PRESENCE_CHECK_IDS,
  createPresenceRegistry,
  presenceInput,
  printfulMissing,
  printfulOrphan,
  printfulUnsynced,
  stripeArchived,
  stripeMissing,
  stripeOrphan,
  summarisePresence,
} from "./checks/product-presence.js";
export type {
  PresenceCheckId,
  ProductPresenceInput,
  ProductSystemsRead,
} from "./checks/product-presence.js";
export {
  SUBSCRIPTION_CHECKS,
  SUBSCRIPTION_CHECK_IDS,
  createSubscriptionRegistry,
  planArchived,
  planIntervalMismatch,
  planMissingOnPage,
  planPriceMismatch,
  planTrialMismatch,
} from "./checks/plans.js";
export type { SubscriptionCheckId, SubscriptionCheckInput } from "./checks/plans.js";
export {
  MAX_PLANS,
  PLAN_BLOCK_LINES,
  PLAN_METADATA_KEY,
  PLAN_TIERS,
  describeCadence,
  findAmounts,
  matchPlans,
  parseCadence,
  parseTaxDisplay,
  parseTrial,
  planKey,
  planPageOf,
  planPaths,
  plansConfigSchema,
  readPagePlans,
  sameCadence,
} from "./plans/index.js";
export type {
  Cadence,
  PagePlan,
  PlanConfig,
  PlanMatch,
  PlanMatchResult,
  PlanPage,
  PlanTier,
  PlansConfig,
  ShownAmount,
  TaxDisplay,
  TrialDays,
} from "./plans/index.js";
export { TIERS, matchProducts, normaliseName, normaliseSku } from "./products/match.js";
export type {
  AmbiguousMatch,
  MatchEvidence,
  MatchResult,
  ProductGroup,
  System as MatchSystem,
  Tier as MatchTier,
} from "./products/match.js";
export {
  CrmUnavailableError,
  crmConfigSchema,
  isBlank as isBlankCrmField,
  isPersonalField,
  leadWindowStart,
  splitFields as splitCrmFields,
  stripPersonal,
} from "./sources/crm.js";
export type {
  CrmConfig,
  CrmCount,
  CrmField,
  CrmLead,
  CrmSample,
  CrmSource,
} from "./sources/crm.js";
export { CRM_ENV_VARS, NO_CRM, NO_TRANSPORT, lazyCrm, noCrm, readCrm } from "./sources/crm-read.js";
export type { CrmRead, CrmSettings } from "./sources/crm-read.js";
export {
  MAX_CALLS as CRM_MAX_CALLS,
  McpHttpError,
  NotReadOnlyServerError,
  SALESFORCE_READ_ONLY_SANDBOX_URL,
  SALESFORCE_READ_ONLY_URL,
  isReadOnlySalesforceServer,
  readOnlyServerAddress,
  salesforceMcpSource,
} from "./sources/salesforce-mcp.js";
export type { McpMessage, McpReply, McpTransport } from "./sources/salesforce-mcp.js";
export { listingsConfigSchema } from "./listings/config.js";
export type { ListingsConfig } from "./listings/config.js";
export {
  LISTING_ENV_VARS,
  lazyListings,
  listingConnectors,
  readListings,
} from "./listings/read.js";
export type { ListingsRead, ListingsSettings } from "./listings/read.js";
export type { Listing, ListingSource, ListingStatus, SpecialDay } from "./listings/types.js";
export { listingsFromAppleCsv } from "./listings/sources/apple.js";
export { listingFromBusinessProfile, listingFromPlace } from "./listings/sources/google.js";
export { listingFromYelp } from "./listings/sources/yelp.js";
export { reconcile, recipientKey } from "./delivery/reconcile.js";
export type { PaidOrder, Reconciled, SentEmail } from "./delivery/reconcile.js";
export { DEFAULT_WINDOW, MAX_WINDOW_DAYS, parseWindow } from "./delivery/window.js";
export type { Window as DeliveryWindow } from "./delivery/window.js";
export {
  STALE_AFTER_SECONDS,
  STRIPE_EVENT_RETENTION_DAYS,
  attribute as attributeWebhookEvents,
  endpointHost,
  formatAge,
} from "./delivery/webhooks.js";
export type { WebhookEndpointState } from "./delivery/webhooks.js";
export { runDelivery, runWebhooks } from "./delivery/run.js";
export {
  SUPABASE_PLATFORM_CHECKS,
  createSupabasePlatformRegistry,
  runSupabasePlatform,
  supabaseRlsOff,
  supabaseSecurityAdvisor,
} from "./checks/supabase-platform.js";
export type { SupabasePlatformInput } from "./checks/supabase-platform.js";
export {
  SOURCE_LIMITS,
  isSecretLookingName,
  readLocalSource,
  sourcePaths,
} from "./local-source/read.js";
export type { SkipReason, SourceLimits, SourceTree } from "./local-source/read.js";
export {
  STATIC_CHECKS,
  createStaticRegistry,
  runStaticChecks,
  staticFile,
} from "./local-source/run.js";
export type { LocalSourceInput, StaticFile } from "./local-source/run.js";
export {
  PROJECT_REF as SUPABASE_PROJECT_REF,
  SUPABASE_ACCESS_TOKEN,
  platformsConfigSchema,
} from "./sources/supabase-config.js";
export type { PlatformsConfig } from "./sources/supabase-config.js";
export type { SupabaseRead } from "./adapters/supabase-mcp-read.js";
export type { DeliveryOptions, DeliveryRun, WebhooksOptions, WebhooksRun } from "./delivery/run.js";
export {
  RECEIPT_CHECKS,
  WEBHOOK_CHECKS,
  createReceiptRegistry,
  createWebhookRegistry,
  deliveryReceiptMissing,
  webhookDisabled,
  webhookFailing,
} from "./checks/delivery.js";
export type { ReceiptInput, WebhookInput } from "./checks/delivery.js";
export { createStripeOrdersConnector, STRIPE_ORDERS_NEEDS } from "./connectors/stripe-orders.js";
export {
  RESEND_API_KEY,
  RESEND_MAX_PAGES,
  RESEND_PAGE_SIZE,
  RESEND_RETENTION_DAYS,
  createResendSentConnector,
  resendTime,
} from "./connectors/resend-sent.js";
export {
  createStripeWebhooksConnector,
  STRIPE_WEBHOOKS_NEEDS,
} from "./connectors/stripe-webhooks.js";

// Query check (G27): the GROQ in a repository, read into shapes. No request is made.
export { extractGroq } from "./query/extract.js";
export type { ExtractOptions, GroqExtraction } from "./query/extract.js";
export { readGroq } from "./query/shape.js";
export type { FieldUse, QueryShape, SourceRef, Unreadable } from "./query/shape.js";
export {
  TITLES as QUERY_TITLES,
  buildCountQuery,
  compareWithCounts,
  countedPath,
  countedPaths,
  fetchCounts,
} from "./query/counts.js";
export type { FetchCountsOptions, TypeCounts } from "./query/counts.js";
export { DUPE_TITLES, dupeFindings, dupesQuery, findDupes } from "./query/dupes.js";
export type { DupeGroup } from "./query/dupes.js";
export {
  MUTATION_TITLES,
  checkMutations,
  extractMutations,
  readMutations,
  readSchema,
  readSchemaFile,
  readSchemaFileFull,
} from "./query/mutations.js";
export type {
  MutationExtraction,
  MutationExtractOptions,
  MutationKind,
  MutationShape,
  SchemaFile,
  MutationUnreadable,
  SchemaField,
  SchemaShape,
  ValueKind,
} from "./query/mutations.js";
export {
  GRAPHQL_TITLES,
  GRAPHQL_TOKEN,
  INTROSPECTION_QUERY,
  checkGraphql,
  defaultGraphqlEndpoint,
  displayEndpoint,
  extractGraphql,
  graphqlShapes,
  graphqlToken,
  introspect,
  isDocumentType,
  isSanityHost,
  parseSanityEndpoint,
  readGraphqlSchemaFile,
  sanityGraphqlEndpoint,
  schemaFromIntrospection,
  schemaFromSdl,
  schemaFromText,
} from "./query/graphql.js";
export type {
  GqlFieldUse,
  GqlSchema,
  GqlStep,
  GraphqlExtractOptions,
  GraphqlExtraction,
} from "./query/graphql.js";
export { analyseUnused, findUnusedFields } from "./query/unused.js";
export type {
  CouldNotFollow,
  FetchedField,
  UnusedAnalysis,
  UnusedOptions,
} from "./query/unused.js";
export {
  QUERY_UNUSED_CHECKS,
  UNUSED_TITLE,
  createUnusedRegistry,
  queryFieldUnused,
} from "./checks/query-unused.js";
export {
  GENERATED_TITLES,
  MAX_DOCUMENTS,
  MAX_RULES,
  MAX_RULE_LENGTH,
  RuleError,
  checkRefs,
  checkTotals,
  groupByDocument,
  parseRefsRule,
  parseTotalsRule,
  refsQuery,
  totalsQuery,
} from "./query/generated.js";
export type { RefsRule, TotalsRule } from "./query/generated.js";
export {
  QUERY_GENERATED_CHECKS,
  createGeneratedRegistry,
  generatedRefUnpublished,
  generatedTotalMismatch,
  generatedTotalMissing,
} from "./checks/query-generated.js";
export {
  checkMutationsOnly,
  checkUnusedOnly,
  compareGenerated,
  compareGraphql,
  compareQueries,
  readShapeForType,
  suggestForType,
} from "./query/run.js";
export type {
  GeneratedCompareOptions,
  GraphqlCompareOptions,
  QueryCompareOptions,
  QueryCompareRun,
  SuggestOptions,
  SuggestRun,
} from "./query/run.js";
export {
  BASELINE_SCHEMA,
  diffBaseline,
  gapKey,
  gapOf,
  likelyRenames,
  parseBaseline,
  serializeBaseline,
  toBaseline,
} from "./query/baseline.js";
export type { BaselineGap, QueryBaseline } from "./query/baseline.js";
export { DEFAULT_SAMPLE, MAX_SAMPLE, readContentShape } from "./query/content-shape.js";
export type { ContentShape, FieldKind, FieldShape } from "./query/content-shape.js";
export { suggestQuery } from "./query/suggest.js";
export { scaffoldRoute } from "./query/scaffold.js";
export type { GeneratedFile } from "./query/scaffold.js";
export {
  QUERY_CHECKS,
  createQueryRegistry,
  queryFieldAbsent,
  queryFieldPartial,
  queryNoDraftsFilter,
  queryTypeEmpty,
} from "./checks/query-counts.js";
export type { QueryInput } from "./checks/query-counts.js";
export {
  GRAPHQL_CHECKS,
  createGraphqlRegistry,
  graphqlFieldNotInSchema,
} from "./checks/query-graphql.js";
export {
  MUTATION_CHECKS,
  createMutationsRegistry,
  mutationNoDrafts,
  mutationMissingRequired,
  mutationRefAsString,
  mutationSharedField,
  mutationUndeclaredField,
} from "./checks/query-mutations.js";
export {
  QUERY_DUPE_CHECKS,
  createDupesRegistry,
  queryDupeSlug,
  queryDupeTitle,
} from "./checks/query-dupes.js";
export {
  QueryTooLongError,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  createSanityRead,
} from "./connectors/sanity.js";
export type { SanityRead } from "./connectors/sanity.js";
export { discoverRoutes, findAppDir, readRoutes } from "./routes/discover.js";
export type { RouteDiscovery, RouteEntry } from "./routes/discover.js";
export {
  anonymousPageAsk,
  classifyAnswer,
  planProbes,
  probeRouteDetails,
  probeRoutes,
  routeAddress,
  sniffPage,
} from "./routes/probe.js";
export type { ProbeResult, RouteAnswer, SkippedRoute } from "./routes/probe.js";
export { SESSION_HELPERS } from "./routes/scan.js";
export { checkRoutes } from "./routes/run.js";
export type { RoutesRun, RoutesRunOptions } from "./routes/run.js";
export {
  NO_ROUTES_CONSENT_REASON,
  ROUTE_CHECKS,
  ROUTE_TITLE,
  createRoutesRegistry,
  routeHiddenNotProtected,
} from "./checks/route-hidden-not-protected.js";
export type { RoutesInput } from "./checks/route-hidden-not-protected.js";
export { emailsConfigSchema } from "./emails/config.js";
export type { EmailsConfig, TrackingRule } from "./emails/config.js";
export { PLACEHOLDER_RULES, findPlaceholders } from "./emails/placeholders.js";
export type { PlaceholderMatch, PlaceholderRule } from "./emails/placeholders.js";
export { nameEmail, pairEmails } from "./emails/pair.js";
export type { EmailPairs, NamedEmail } from "./emails/pair.js";
export { KNOWN_TRACKING, unwrapTracking } from "./emails/tracking.js";
export { maskSource, parseEmail } from "./emails/parse.js";
export type { EmailImage, EmailLink, ParsedEmail } from "./emails/parse.js";
export { MAX_EMAILS, MAX_EMAIL_BYTES, readEmailFolder } from "./emails/read.js";
export type { EmailFolder, EmailSource } from "./emails/read.js";
export { NO_BASE_REASON, checkEmails } from "./emails/run.js";
export type { EmailsOptions, EmailsRun, EmailSummary } from "./emails/run.js";
export {
  EMAIL_CHECKS,
  EMAIL_NETWORK_CHECKS,
  EMAIL_PAGE_CHECKS,
  badHref,
  createEmailRegistry,
  emailImageNotAbsolute,
  emailNoTextPart,
  emailPreviewPlaceholder,
  emailRelativeLink,
} from "./checks/email-templates.js";
export type { EmailInput, EmailPlaceholder } from "./checks/email-templates.js";

export { createRenewalsRegistry } from "./renewals/registry.js";
export { RENEWALS_CHECKS } from "./checks/renewals.js";
export { renewalsConfigSchema } from "./renewals/config.js";
export type { RenewalsConfig } from "./renewals/config.js";
export { DAY_MS, daysUntil, expiryPhrase, urgency, writeDate } from "./renewals/dates.js";
export { createRdapClient, isHold, parseRdapDomain, IANA_BOOTSTRAP } from "./renewals/rdap.js";
export type { RdapClient, Registration, RegistrationRead } from "./renewals/rdap.js";
export { certificateHosts, readCertificates } from "./renewals/certs.js";
export type { CertRead } from "./renewals/certs.js";
export { registrableOf } from "./renewals/suffix.js";
export type { Registrable } from "./renewals/suffix.js";
export {
  NODE_RETIREMENTS,
  NODE_RETIREMENTS_MAX_AGE_DAYS,
  NODE_RETIREMENTS_WRITTEN,
  nodeMajor,
  retirementsStale,
  runtimeStatus,
} from "./renewals/runtimes.js";
export type { RuntimeRetirement, RuntimeStatus } from "./renewals/runtimes.js";
export {
  GITHUB_TOKEN_VAR,
  RENEWALS_ENV_VARS,
  VERCEL_TOKEN_VAR,
  parseGithubExpiry,
  parseVercelExpiry,
} from "./renewals/tokens.js";
export type { ProjectRuntime, TokenRead } from "./renewals/tokens.js";
export { createRenewals } from "./renewals/reader.js";
export type { RenewalRow, Renewals, RenewalsSettings, RuntimesRead } from "./renewals/reader.js";
export { RENEWAL_CHECK_IDS, renewalDate, renewalItems, renewalLine } from "./renewals/section.js";
export type { RenewalItem } from "./renewals/section.js";
export { formatRenewalRows } from "./renewals/format.js";

export { createHandoffRegistry } from "./handoff/registry.js";
export { HANDOFF_CHECKS } from "./checks/handoff.js";
export { handoffConfigSchema, MANUAL_SYSTEM_IDS } from "./handoff/config.js";
export type { HandoffConfig } from "./handoff/config.js";
export { createHandoff, HANDOFF_ENV_VARS } from "./handoff/reader.js";
export type { Handoff, HandoffSettings, HandoffSource } from "./handoff/reader.js";
export { createPeople, maskEmail, normalizeEmail } from "./handoff/people.js";
export type { People, PeopleConfig } from "./handoff/people.js";
export { googleRole, isAdminRole, sanityRole, vercelRole } from "./handoff/roles.js";
export { readVercel } from "./handoff/vercel.js";
export { readSanity } from "./handoff/sanity.js";
export { readGoogleAdmins } from "./handoff/google.js";
export { dnsProviderOf, helpFor } from "./handoff/providers.js";
export {
  HANDOFF_FILES,
  buildHandoff,
  formatHandoffLines,
  handoffFiles,
  renderHandoffHtml,
  renderHandoffMarkdown,
} from "./handoff/report.js";
export type {
  BuildInput as HandoffBuildInput,
  ChecklistItem as HandoffChecklistItem,
  HandoffFile,
  HandoffSummary,
  SummaryFinding as HandoffFinding,
  SummarySystem as HandoffSystemSummary,
} from "./handoff/report.js";
export type {
  Account as HandoffAccount,
  ClientAccess,
  DnsSystem,
  DomainSystem,
  ManualSystem,
  Member as HandoffMember,
  Party as HandoffParty,
  PeopleSystem,
  RawMember,
  Role as HandoffRole,
  SourceRead as HandoffSourceRead,
  System as HandoffSystem,
  UnreadSystem,
} from "./handoff/types.js";

export { createCostRegistry } from "./cost/registry.js";
export { COST_CHECKS } from "./checks/cost.js";
export { costConfigSchema, DEFAULT_DELAY_MS, DEFAULT_MINIMUM_SECONDS } from "./cost/config.js";
export type { CostConfig } from "./cost/config.js";
export { COST_ENV_VARS, createCost, isMarkedStatic } from "./cost/reader.js";
export type { Cost, CostSettings } from "./cost/reader.js";
export { buildCostSummary, formatCostSummary } from "./cost/summary.js";
export type { CostSummary, ProviderSummary } from "./cost/summary.js";
export { detectBuilder, HOSTED_BUILDERS } from "./cost/builders.js";
export type { HostedBuilder } from "./cost/builders.js";
export { stripVolatile, firstDifference, VOLATILE_RULES } from "./cost/volatile.js";
export { cacheRead, lifetimeOf } from "./cost/cache.js";
export { judgePage, causesOf, compareVisits } from "./cost/judge.js";
export type { Cause, Judgement, Observation, PageRead } from "./cost/judge.js";
export { detectJumps, formatQuantity } from "./cost/usage.js";
export type { Jump, Metric, UsageProviderRead, UsageRead } from "./cost/usage.js";
export { readSanityUsage, readVercelUsage } from "./cost/providers.js";

export { brandSchema, safeLogoUrl, servicesConfigSchema, servicesProblem } from "./audit/config.js";
export type { Brand, Service, ServicesConfig } from "./audit/config.js";
export { buildAuditPack, EVIDENCE_LINES, forProspect, joinNames, TOP } from "./audit/pack.js";
export type {
  AuditPack,
  PackFinding,
  PackGroup,
  PackOptions,
  PackRange,
  PackTotals,
} from "./audit/pack.js";
export {
  AUDIT_PACK_FILES,
  auditPackFiles,
  packBlocks,
  renderPackHtml,
  renderPackMarkdown,
} from "./audit/render.js";
export type { AuditPackFile } from "./audit/render.js";

export { MIGRATION_CHECKS, createMigrationRegistry, unreadPages } from "./checks/migration.js";
export { WEBFLOW_CHECKS, createWebflowRegistry } from "./checks/webflow.js";
export { SHOPIFY_CHECKS, createShopifyRegistry } from "./checks/shopify.js";
export { CONTENTFUL_CHECKS, createContentfulRegistry } from "./checks/contentful.js";
export {
  SQUARESPACE_COMMERCE_CHECKS,
  createSquarespaceCommerceRegistry,
} from "./checks/squarespace-commerce.js";
export { STRAPI_CHECKS, createStrapiRegistry } from "./checks/strapi.js";
export { CRAFT_CHECKS, createCraftRegistry } from "./checks/craft.js";
export { HYGRAPH_CHECKS, createHygraphRegistry } from "./checks/hygraph.js";
export { UMBRACO_CHECKS, createUmbracoRegistry } from "./checks/umbraco.js";
export { SITECORE_CHECKS, createSitecoreRegistry } from "./checks/sitecore.js";
export { JOOMLA_CHECKS, createJoomlaRegistry } from "./checks/joomla.js";
export { DATOCMS_CHECKS, createDatocmsRegistry } from "./checks/datocms.js";
export { PRISMIC_CHECKS, createPrismicRegistry } from "./checks/prismic.js";
export { DIRECTUS_CHECKS, createDirectusRegistry } from "./checks/directus.js";
export { DRUPAL_CHECKS, createDrupalRegistry } from "./checks/drupal.js";
export { PAYLOAD_CHECKS, createPayloadRegistry } from "./checks/payload.js";
export { KONTENT_AI_CHECKS, createKontentAiRegistry } from "./checks/kontent-ai.js";
export { HUBSPOT_CMS_CHECKS, createHubspotCmsRegistry } from "./checks/hubspot-cms.js";
export {
  ListBuilder,
  MIGRATION_ITEM_CAP,
  itemPath,
  parseWordPress,
  plainText,
  readExportFile,
} from "./migration/list.js";
export type { ListSource, OldItem, OldList } from "./migration/list.js";
export { readOldSite } from "./migration/old-site.js";
export { SITE_WIDE_TYPES, factsOf, readMigration } from "./migration/read.js";
export type { ItemRead, MigrationReading, NewRead, PageFacts } from "./migration/read.js";
export { normaliseTitle, sameTitle, titleKept } from "./migration/titles.js";

export { PUBLISHED_CHECKS } from "./checks/published-not-live.js";
export { addPublishedChecks } from "./published/registry.js";
export { PUBLISHED_DEFAULTS, createPublished } from "./published/reader.js";
export type {
  LiveItem,
  PageOutcome,
  Published,
  PublishedReading,
  StillLive,
} from "./published/reader.js";
export { differingFields, pageTexts, variantsOf } from "./published/compare.js";
export { TRACKER_CHECKS } from "./checks/trackers.js";
export { trackersConfigSchema, TRACKERS_CONFIG_FILE } from "./trackers/config.js";
export type { TrackersConfig } from "./trackers/config.js";
export { addTrackerChecks } from "./trackers/registry.js";
export { createTrackers, containerUrl, CONTAINER_CAP } from "./trackers/reader.js";
export type { ContainerRead, Trackers } from "./trackers/reader.js";
export {
  FINGERPRINTS,
  findTrackers,
  findTrackersInContainer,
  decodeContainer,
  containerIds,
} from "./trackers/fingerprints.js";
export type { Fingerprint, Tracker, TrackerGroup } from "./trackers/fingerprints.js";
export { sensitiveReason, collectsDetails } from "./trackers/sensitive.js";

export { LIBRARY_CHECKS } from "./checks/libraries.js";
export { addLibraryChecks } from "./libraries/registry.js";
export { createLibraries, LIBRARY_SCRIPT_CAP } from "./libraries/reader.js";

// C-01: the WordPress checks (wp-outdated, wp-users-exposed), off unless --wordpress
export { WORDPRESS_CHECKS, WORDPRESS_LOOKUP_CAP, restRootOf } from "./checks/wordpress.js";
export { addWordPressChecks } from "./wordpress/registry.js";
export { createWordPress, WORDPRESS_API } from "./wordpress/reader.js";
export type { Latest, UsersRead, WordPress } from "./wordpress/reader.js";
export type { Libraries, ScriptReading } from "./libraries/reader.js";
export { detect, looksMinified, MAX_SCRIPT_CHARS } from "./libraries/detect.js";
export type { Detection, EvidenceKind } from "./libraries/detect.js";
export {
  advisoriesFor,
  LIBRARY_ADVISORIES,
  LIBRARY_ADVISORIES_WRITTEN,
  LIBRARY_NAMES,
} from "./libraries/advisories.js";
export type { Advisory, AdvisoryMatch, AffectedRange, LibraryId } from "./libraries/advisories.js";
export { compareVersions, parseVersion } from "./libraries/version.js";
export type { ParsedVersion } from "./libraries/version.js";

// F-09: "is my client affected?" (gaugeline advisory, and the MCP tool's definition)
export { checkAdvisory } from "./advisory/run.js";
export type { AdvisoryOptions } from "./advisory/run.js";
export {
  renderNote as renderAdvisoryNote,
  renderTerminal as renderAdvisoryTerminal,
} from "./advisory/render.js";
export {
  ADVISORY_SCHEMA_VERSION,
  VERDICTS as ADVISORY_VERDICTS,
  advisoryResultSchema,
} from "./advisory/schema.js";
export type { AdvisoryResult, Verdict as AdvisoryVerdict } from "./advisory/schema.js";
export { ADVISORY_TOOL, advisoryToolInput, runAdvisoryTool } from "./advisory/tool.js";
export type { AdvisoryToolDeps, AdvisoryToolInput } from "./advisory/tool.js";
export { isAdvisoryId } from "./advisory/target.js";
export type { WordPressData } from "./advisory/evidence.js";
export * from "./adapters/index.js";

export { BACKUPS_CHECKS } from "./checks/backups.js";
export { addBackupsChecks, createBackupsRegistry } from "./backups/registry.js";
export {
  backupsConfigSchema,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_SHRINK_PERCENT,
} from "./backups/config.js";
export type { BackupsConfig } from "./backups/config.js";
export { BACKUPS_ENV_VARS, readSanityBackups, readSupabaseBackups } from "./backups/providers.js";
export { createBackups } from "./backups/reader.js";
export type { Backups, BackupsSettings } from "./backups/reader.js";
export { buildBackupsSummary, formatBackupsSummary } from "./backups/summary.js";
export type { BackupsSummary } from "./backups/summary.js";
export { manualBackups } from "./backups/manual.js";
export type { ManualBackup } from "./backups/manual.js";
export { exportDateOf, judgeExports, formatBytes } from "./backups/judge.js";
export type {
  BackupsReading,
  ExportFile,
  ExportLister,
  ExportRead,
  PlatformRead,
  RawExportFile,
  RawListing,
} from "./backups/types.js";

// gaugeline init: detect a site's stack from outside and propose starter settings files (F-07).
export { detectAdapters, matchDetection, signsOf } from "./init/hints.js";
export type { AdapterSigns, AdapterSighting } from "./init/hints.js";
export type { AdapterDetection } from "./adapters/entry.js";
export { LINKED_PAGES, detectStack, linkedPaths } from "./init/stack.js";
export type { DetectOptions, PaymentSighting, Sighting, StackReport } from "./init/stack.js";
export {
  ADAPTERS_FILE as INIT_ADAPTERS_FILE,
  NOTES_FILE as INIT_NOTES_FILE,
  planInit,
  renderNotes as renderInitNotes,
} from "./init/plan.js";
export type { InitEnvVar, InitFile, InitPlan, NextStep } from "./init/plan.js";
export { renderInit } from "./init/render.js";
export type { InitOutput } from "./init/render.js";
export {
  aiConfigSchema,
  AI_CONFIG_FILE,
  AI_INTENTS,
  wantsAllowed,
  intentMismatches,
} from "./ai-intent.js";
export type { AiConfig, AiIntent } from "./ai-intent.js";

export { changesConfigSchema, DEFAULT_RETENTION_DAYS } from "./changes/config.js";
export type { ChangesConfig } from "./changes/config.js";
export { buildPageRecord, diffRecords } from "./changes/record.js";
export {
  findingKey as recordedFindingKey,
  inOrder,
  newFindings,
  parseSince,
  pruneRuns,
  runId,
} from "./changes/history.js";
export type { Appearance, Since } from "./changes/history.js";
export { attribute } from "./changes/attribute.js";
export { compareRuns, formatBeforeAfter } from "./changes/compare.js";
export type { BeforeAfter, BeforeAfterResult, RunRef } from "./changes/compare.js";
export {
  buildChanges,
  describe as describeChange,
  formatChanges,
  warrantyNote,
} from "./changes/report.js";
export type { ChangeItem, ChangeSources, ChangesReport, Warranty } from "./changes/report.js";
export { createChangeSources } from "./changes/sources.js";
export { readDeploys } from "./changes/deploys.js";
export { HISTORY_SCHEMA, RUN_ID, isRunRecord } from "./changes/types.js";
export type {
  ChangeLabel,
  Deploy,
  FieldChange,
  PageRecord,
  RecordedFinding,
  Revision,
  RunRecord,
  SourceRead,
} from "./changes/types.js";
export {
  CUT_MARKER,
  DEFAULT_UNTRUSTED_MAX_CHARS,
  UNTRUSTED_CAPS,
  UNTRUSTED_FIELD_NOTE,
  markUntrusted,
  sanitise,
  wrapFindingForAgent,
} from "./untrusted.js";
export type { AgentFinding, Sanitised, UntrustedField, UntrustedText } from "./untrusted.js";
export {
  TERMINAL_EVIDENCE_MAX,
  forDiscord,
  forMarkdown,
  forSlack,
  forSlackPlain,
  forTerminal,
  stripAnsi,
} from "./untrusted-output.js";
export type { OutputFormat, SafeText } from "./untrusted-output.js";
export {
  AGENT_DENY_REASONS,
  AGENTS_OFF_ENV,
  MAX_COST_MICROS,
  agentsOff,
  createAgentPolicy,
  isAgentDenyReason,
} from "./agent-policy.js";
export type {
  AgentCall,
  AgentDecision,
  AgentDenyLog,
  AgentDenyReason,
  AgentLimits,
  AgentPolicy,
  AgentPolicyConfig,
  AgentRule,
} from "./agent-policy.js";
export {
  AGENT_TRACE_DECISIONS,
  MAX_TRACE_STRING,
  agentTraceRecord,
  redactForTrace,
  traceHash,
  traceLine,
} from "./agent-trace.js";
export type { AgentTraceDecision, AgentTraceInput, AgentTraceRecord } from "./agent-trace.js";
export * from "./fixes/index.js";
export * from "./approval-receipts/index.js";
export {
  EVAL_ASSERTIONS,
  EVAL_MODEL_TOOL,
  EvalReplayError,
  MAX_EVAL_INPUT_CHARS,
  createReplayModel,
  formatEvalReport,
  isWriteTool,
  parseRecording,
  runEvals,
  validateEvalSet,
} from "./evals/index.js";
export type {
  EvalAssertionResult,
  EvalAgent,
  EvalAssertionId,
  EvalCase,
  EvalCaseResult,
  EvalFinding,
  EvalInput,
  EvalJudge,
  EvalJudgement,
  EvalModel,
  EvalModelRequest,
  EvalRecording,
  EvalReport,
  EvalToolCall,
  EvalUsage,
  GoldenCase,
  JudgedVerdict,
  KnownBadCase,
} from "./evals/index.js";
export {
  APPROVALS_DIGEST_AGENT,
  APPROVALS_DIGEST_KINDS,
  APPROVAL_WINDOW_HOURS,
  ApprovalsDigestInputError,
  MAX_ATTENTION,
  MAX_DIGEST_ROWS,
  approvalsDigestAgent,
  approvalsDigestCases,
  approvalsDigestSchema,
  buildApprovalsDigest,
  createApprovalsDigestModel,
  renderApprovalsDigestMarkdown,
} from "./approvals-digest/index.js";
export type {
  ApprovalsDigest,
  ApprovalsDigestItem,
  ApprovalsDigestKind,
  ApprovalsDigestOptions,
} from "./approvals-digest/index.js";
