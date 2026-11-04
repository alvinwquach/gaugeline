export { parseAddress } from "./address.js";
export type { AddressResult } from "./address.js";
export {
  AREAS,
  CheckRegistry,
  RESULT_SCHEMA,
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
