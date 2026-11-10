import type { ComponentType } from "react";
import type { RunState } from "./store";
import { Ads } from "./views/Ads";
import { LeaksAccess } from "./views/LeaksAccess";
import { Overview } from "./views/Overview";
import { PagesChecked } from "./views/PagesChecked";
import { Problems } from "./views/Problems";
import { SearchData } from "./views/SearchData";

export interface View {
  id: string;
  label: string;
  component: ComponentType<{ run: RunState }>;
}

/**
 * The views, in the order the navigation shows them. Each later branch adds one entry here and
 * nothing in the shell changes. The first is the one a run opens on.
 */
export const VIEWS: readonly View[] = [
  { id: "overview", label: "Overview", component: Overview },
  { id: "problems", label: "Problems", component: Problems },
  { id: "pages", label: "Pages checked", component: PagesChecked },
  { id: "search", label: "Search data", component: SearchData },
  { id: "leaks", label: "Leaks & access", component: LeaksAccess },
];

/**
 * The views of a run made from an ads export (gaugeline open --ads): the ads table first, then the
 * same Problems view a page run has. They exist only for such a run, so a session with no ads run
 * never shows an Ads link, and a page run is unchanged.
 */
export const ADS_VIEWS: readonly View[] = [
  { id: "ads", label: "Ads", component: Ads },
  { id: "problems", label: "Problems", component: Problems },
];

/** The views the navigation shows for this run, and the one it opens on (the first). */
export const viewsFor = (run: Pick<RunState, "kind"> | undefined): readonly View[] =>
  run?.kind === "ads" ? ADS_VIEWS : VIEWS;
