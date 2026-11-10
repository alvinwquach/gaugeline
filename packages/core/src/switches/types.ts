import type { AvailabilityRule, CapacityRule, SwitchRule } from "./config.js";

/** Why a state is not known. A state that is not known is never a pass, and never a finding. */
export interface Unknown {
  state: "unknown";
  reason: string;
}

export type SwitchResult = {
  id: string;
  source: string;
  rule: SwitchRule;
} & ({ state: "on" | "off" } | Unknown);

/** An item name as the database holds it, and the same made safe to print. */
export interface ItemName {
  name: string;
  shown: string;
}

export type AvailabilityResult = {
  id: string;
  source: string;
  rule: AvailabilityRule;
} & ({ state: "known"; items: ItemName[] } | Unknown);

export type CapacityResult = {
  id: string;
  source: string;
  rule: CapacityRule;
} & ({ state: "known"; remaining: number } | Unknown);

/** What every rule in gaugeline.switches.json reads out to, in the order of the file. */
export interface SwitchesRead {
  switches: SwitchResult[];
  availability: AvailabilityResult[];
  capacity: CapacityResult[];
  /** Every path the file names, so a check can read the pages its rules are about. */
  paths: string[];
}
