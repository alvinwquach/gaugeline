import { formatHash } from "./route";
import type { RunState } from "./store";
import { LEVELS, LEVEL_LABEL } from "./types";
import { viewsFor } from "./views";

const STATE_TEXT = { running: "Checking", done: "Done", failed: "Could not run" } as const;

/** The open view's id if this run has it (an ads run has no Overview), else the run's first view. */
const viewFor = (run: RunState, viewId: string): string => {
  const own = viewsFor(run);
  return own.some((v) => v.id === viewId) ? viewId : (own[0]?.id ?? viewId);
};

/**
 * Every page checked this session, oldest first (the order of the Map, which is the server's order).
 * The address is cut short by the stylesheet, never in the text, so a screen reader reads all of it.
 */
export function Sidebar({
  runs,
  activeId,
  viewId,
}: {
  runs: ReadonlyMap<string, RunState>;
  activeId: string | null;
  viewId: string;
}) {
  return (
    <nav className="sidebar" aria-label="Pages checked this session">
      {runs.size === 0 ? (
        <p className="sidebar-empty">Nothing checked yet.</p>
      ) : (
        <ol>
          {[...runs.values()].map((run) => (
            <li key={run.id}>
              <a
                href={formatHash(run.id, viewFor(run, viewId))}
                aria-current={run.id === activeId ? "page" : undefined}
                className="run-link"
              >
                <span className="run-url" title={run.url}>
                  {run.url}
                </span>
                <span className={`run-state state-${run.state}`}>{STATE_TEXT[run.state]}</span>
                {run.state === "done" && run.counts ? (
                  <span className="run-counts">
                    {LEVELS.map((level, i) => (
                      <span key={level} className={`chip level-${level}`}>
                        <b>{run.counts?.[level]}</b> {LEVEL_LABEL[level]}
                        {i < LEVELS.length - 1 ? <span className="sr-only">, </span> : null}
                      </span>
                    ))}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
