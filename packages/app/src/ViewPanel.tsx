import { isOff } from "./features";
import type { RunState } from "./store";
import type { View } from "./views";
import { ComingSoon } from "./views/ComingSoon";

/**
 * The open view. A view whose flag is off shows the placeholder whatever its component is, so going
 * to its address directly can't mount code that is not meant to be reachable yet.
 */
export function ViewPanel({ view, run }: { view: View; run: RunState }) {
  if (isOff(view)) return <ComingSoon feature={view.feature} />;
  const Component = view.component;
  return <Component run={run} />;
}
