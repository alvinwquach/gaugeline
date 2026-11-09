import type { ComponentType } from "react";
import type { RunState } from "./store";
import { Overview } from "./views/Overview";

export interface View {
  id: string;
  label: string;
  component: ComponentType<{ run: RunState }>;
}

/**
 * The views, in the order the navigation shows them. Each later branch adds one entry here and
 * nothing in the shell changes. The first is the one a run opens on.
 */
export const VIEWS: readonly View[] = [{ id: "overview", label: "Overview", component: Overview }];
