/**
 * Which views of the app are switched on. A flag is a constant in this one module: no environment
 * variable, no query parameter and no stored switch can turn a view on, so a view with no code
 * behind it can never be reached. Version 0.2 turns a view on by flipping its boolean here, next to
 * the real component it gets in views.ts.
 */
export type FeatureId = "pageCost" | "automaticMessages" | "content";

export interface Feature {
  label: string;
  enabled: boolean;
  /** Said to a screen reader and shown under the label while the view is off. */
  note: string;
}

const NEEDS_SANITY = "Needs your Sanity login. Coming in version 0.2.";

export const FEATURES: Record<FeatureId, Feature> = {
  pageCost: { label: "Page cost", enabled: false, note: NEEDS_SANITY },
  automaticMessages: { label: "Automatic messages", enabled: false, note: NEEDS_SANITY },
  content: { label: "Content", enabled: false, note: NEEDS_SANITY },
};

/** True for a view that names a feature which is switched off. Read each time, so a flag change is seen. */
export const isOff = <T extends { feature?: FeatureId }>(
  view: T,
): view is T & { feature: FeatureId } =>
  view.feature !== undefined && !FEATURES[view.feature].enabled;
