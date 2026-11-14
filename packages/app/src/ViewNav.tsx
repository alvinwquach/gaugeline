import { useId } from "react";
import { FEATURES, isOff } from "./features";
import { formatHash } from "./route";
import type { View } from "./views";

/**
 * The views of the open run. A view that is switched off is a button with aria-disabled, never the
 * disabled attribute: it stays in the Tab order and says why it is off, as its description. The
 * note is the description only (no title, nothing in the name), so it is heard once. Activating it
 * does nothing, because it has no action.
 */
export function ViewNav({
  views,
  runId,
  currentId,
}: {
  views: readonly View[];
  runId: string;
  currentId: string | undefined;
}) {
  const base = useId();
  return (
    <nav className="views" aria-label="Views">
      <ul>
        {views.map((v) =>
          isOff(v) ? (
            <li key={v.id} className="view-off">
              <button
                type="button"
                aria-disabled="true"
                aria-describedby={`${base}-${v.id}`}
                className="view-item"
              >
                {v.label}
              </button>
              <span id={`${base}-${v.id}`} className="view-note">
                {FEATURES[v.feature].note}
              </span>
            </li>
          ) : (
            <li key={v.id}>
              <a
                href={formatHash(runId, v.id)}
                aria-current={v.id === currentId ? "page" : undefined}
              >
                {v.label}
              </a>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
