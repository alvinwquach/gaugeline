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
export type { Area, Check, CheckContext, Finding, Severity, Size } from "./model.js";
export { redact } from "./redact.js";
export { runChecks, sanitiseFinding } from "./runner.js";
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
  describeNetworkFailure,
  createFetcher,
} from "./fetcher.js";
export type { FetchErrorReason, Fetcher, FetcherOptions, GetOptions, Hop } from "./fetcher.js";
export { Semaphore } from "./semaphore.js";
export { BUDGET_KINDS, LIMITS, createBudget, formatSampleSummary } from "./limits.js";
export type { Budget, BudgetKind, BudgetSummary, BudgetTally, Limits } from "./limits.js";
export { dedupeUrls } from "./sample.js";
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
