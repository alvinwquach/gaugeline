export {
  MAX_STATE_PAGES,
  availabilitySchema,
  capacitySchema,
  parseSourceRef,
  referenceProblems,
  resolveQuery,
  ruleName,
  scopePaths,
  sourceRefs,
  switchSchema,
  switchesConfigSchema,
  usesSanity,
} from "./config.js";
export type {
  AvailabilityRule,
  CapacityRule,
  Phrase,
  SourceRef,
  SwitchRule,
  SwitchesConfig,
} from "./config.js";
export { createStatePages, pageLanguage, phrasesFor, targetsFor } from "./pages.js";
export type { StatePage, StatePages, Target } from "./pages.js";
export { lazySwitches, readSwitches } from "./read.js";
export type { SwitchDatabases, SwitchesDeps, SwitchesSettings } from "./read.js";
export {
  cacheNote,
  duration,
  fold,
  findName,
  linksTo,
  menuItemNames,
  sameName,
  says,
  visibleLines,
} from "./text.js";
export type {
  AvailabilityResult,
  CapacityResult,
  ItemName,
  SwitchResult,
  SwitchesRead,
} from "./types.js";
export { capacityValue, switchValue } from "./values.js";
