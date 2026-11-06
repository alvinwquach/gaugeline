export { parseAddress } from "./address.js";
export type { AddressResult } from "./address.js";
export {
  AREAS,
  CheckRegistry,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
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
} from "./fetcher.js";
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
export type { Fact, FactsConfig, Occurrence as FactOccurrence } from "./facts/types.js";
export { ANCHOR_WINDOW, PAYMENT_RULES, configValue, extractPayments } from "./payments/extract.js";
export { DETECTORS, findLeaks, redact as redactSecret } from "./checks/leaks/detectors.js";
export type { Detector, Leak } from "./checks/leaks/detectors.js";
export { PRIVATE_TYPE_WORDS, isPrivateType } from "./checks/leaks/private-types.js";
export { SANITY_QUERY, readDataset, sanityQueryUrl, sanityRefs } from "./sanity.js";
export type { DatasetRead, SanityRef } from "./sanity.js";
export { readScripts } from "./scripts.js";
export { EMAIL_PRESET, LAUNCH_PRESET } from "./presets.js";
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
export { escapeHtml, renderLookedRight, renderReport, renderSampled } from "./report/html.js";
export type { ReportInput } from "./report/html.js";
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
export { isFrameworkUrl } from "./next/framework-urls.js";
export { frameworkLinks } from "./links.js";
export { hiddenConfigSchema, isHidden, matchesGlob, overdue } from "./hidden.js";
export type { HiddenConfig, HiddenSection } from "./hidden.js";
export { eventRuleSchema, eventsConfigSchema, REGIONS } from "./events/types.js";
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
export { KEY_PATTERNS, findKeys, keyPatterns } from "./secrets.js";
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
