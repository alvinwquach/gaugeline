import { useEffect, useRef } from "react";
import { AddressForm } from "./AddressForm";
import { formatHash, useRoute } from "./route";
import { Sidebar } from "./Sidebar";
import { useRuns } from "./store";
import { VIEWS } from "./views";

/** The id of the last run in the Map: the newest, since the Map is in the server's order. */
function newest(runs: ReadonlyMap<string, unknown>): string | null {
  let last: string | null = null;
  for (const id of runs.keys()) last = id;
  return last;
}

/**
 * The frame: the address form, the pages checked this session, the views and the open view.
 * The open run and view are kept in the address (#/<runId>/<viewId>), so a reload or the back button
 * returns to them and the server needs no route for either.
 */
export function Shell() {
  const { runs, activeId, loaded, listError, start, select } = useRuns();
  const route = useRoute();
  const view = VIEWS.find((v) => v.id === route.viewId) ?? VIEWS[0];
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const { go } = route;

  // The address says which run is open. Once the session is listed, a run id that isn't in it
  // (or none) opens the newest run, or nothing when there is none.
  useEffect(() => {
    if (!loaded) return;
    const known = route.runId !== null && runsRef.current.has(route.runId);
    select(known ? route.runId : newest(runsRef.current));
  }, [loaded, route.runId, select]);

  // The other direction: a run that was just started, or the fallback above, is written into the address.
  // A new run adds a history entry; correcting an address that named nothing real replaces it.
  useEffect(() => {
    if (activeId === null || !view || activeId === route.runId) return;
    const namesAnotherRun = route.runId !== null && runsRef.current.has(route.runId);
    go(activeId, view.id, !namesAnotherRun);
    // Only a change of the open run writes the address; the back button changes the address first.
  }, [activeId]);

  // A view id that isn't one of the views opens the first.
  useEffect(() => {
    if (activeId !== null && view && activeId === route.runId && route.viewId !== view.id)
      go(activeId, view.id, true);
  }, [activeId, route.runId, route.viewId, view, go]);

  const active = activeId === null ? undefined : runs.get(activeId);
  const View = view?.component;

  return (
    <div className="app">
      <header className="app-header">
        <p className="brand">Gaugeline</p>
        <AddressForm onSubmit={start} />
      </header>
      <div className="app-body">
        <Sidebar runs={runs} activeId={activeId} viewId={view?.id ?? ""} />
        <div className="content">
          {active ? (
            <nav className="views" aria-label="Views">
              <ul>
                {VIEWS.map((v) => (
                  <li key={v.id}>
                    <a
                      href={formatHash(active.id, v.id)}
                      aria-current={v.id === view?.id ? "page" : undefined}
                    >
                      {v.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <main id="main">
            {active && View ? (
              <View run={active} />
            ) : (
              <Empty loaded={loaded} listError={listError} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Empty({ loaded, listError }: { loaded: boolean; listError: string | undefined }) {
  if (listError)
    return (
      <>
        <h1>Gaugeline</h1>
        <p className="notice">{listError}</p>
      </>
    );
  if (!loaded)
    return (
      <>
        <h1>Gaugeline</h1>
        <p className="muted">Loading this session...</p>
      </>
    );
  return (
    <>
      <h1>Check a page</h1>
      <p>
        Enter an address above, such as yoursite.com. Each page you check appears in the list on the
        left, and stays there until you stop Gaugeline.
      </p>
    </>
  );
}
