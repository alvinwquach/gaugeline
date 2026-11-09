import type { ComponentType } from "react";
import type { RunState } from "./store";
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
