export {
  MAX_SPOT_CHECKS,
  exactPages,
  freshnessConfigSchema,
  freshnessReferenceProblems,
  freshnessSources,
  isPattern,
  matchesPage,
  ruleName,
  usesSanity,
} from "./config.js";
export type { FreshnessConfig, FreshnessRule, SpotCheck } from "./config.js";
export { numberFrom, parseTolerance, show, valueOf, within } from "./decimal.js";
export type { Decimal, Tolerance } from "./decimal.js";
export { describeMonths, judgeAge, judgeLag } from "./judge.js";
export { MAX_FORECAST_ITEMS } from "./page.js";
export { createFreshness } from "./read.js";
export type { Freshness, FreshnessSettings, SourceFigure, SourceTime } from "./read.js";
export { isActive, parseDuration, parseMoment } from "./time.js";
export type { Moment } from "./time.js";
