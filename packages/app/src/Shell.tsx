import { useEffect, useRef, useState } from "react";
import { AddressForm } from "./AddressForm";
import { readSession, reportPath, type AppSession } from "./api";
import { useRoute } from "./route";
import { Sidebar } from "./Sidebar";
import { useRuns } from "./store";
import { ViewNav } from "./ViewNav";
import { ViewPanel } from "./ViewPanel";
import { viewsFor } from "./views";

/** The id of the last run in the Map: the newest, since the Map is in the server's order. */
function newest(runs: ReadonlyMap<string, unknown>): string | null {
  let last: string | null = null;
  for (const id of runs.keys()) last = id;
  return last;
}

/** Shown under "Example results" in the demo. The server says the same sentence when a check is asked for. */
const DEMO_SENTENCE = "This is the demo. Run npx gaugeline open yoursite.com to check a real page.";

/** What kind of session this is. Until it is known, or when it cannot be read, it is a normal one. */
function useAppSession(): AppSession | undefined {
  const [session, setSession] = useState<AppSession>();
  useEffect(() => {
    let live = true;
    readSession().then(
      (s) => live && setSession(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return session;
}

/**
 * The frame: the address form, the pages checked this session, the views and the open view.
 * The open run and view are kept in the address (#/<runId>/<viewId>), so a reload or the back button
 * returns to them and the server needs no route for either.
 */
export function Shell() {
  const { runs, activeId, loaded, listError, start, select } = useRuns();
  const route = useRoute();
  const demo = useAppSession()?.demo === true;
  // The views belong to the run: an ads run has the Ads view, a page run does not.
  const runForViews = route.runId === null ? undefined : runs.get(route.runId);
  const views = viewsFor(runForViews ?? (activeId === null ? undefined : runs.get(activeId)));
  const view = views.find((v) => v.id === route.viewId) ?? views[0];
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
    // The view of the same name if the new run has one (an ads run and a page run share Problems).
    const own = viewsFor(runsRef.current.get(activeId));
    go(activeId, (own.find((v) => v.id === view.id) ?? own[0] ?? view).id, !namesAnotherRun);
    // Only a change of the open run writes the address; the back button changes the address first.
  }, [activeId]);

  // A view id that isn't one of the views opens the first.
  useEffect(() => {
    if (activeId !== null && view && activeId === route.runId && route.viewId !== view.id)
      go(activeId, view.id, true);
  }, [activeId, route.runId, route.viewId, view, go]);

  const active = activeId === null ? undefined : runs.get(activeId);

  return (
    <div className="app">
      <header className="app-header">
        <p className="brand">Gaugeline</p>
        <AddressForm onSubmit={start} disabled={demo} />
      </header>
      {demo ? (
        <div className="demo-banner" role="note">
          <strong>Example results</strong> <span>{DEMO_SENTENCE}</span>
        </div>
      ) : null}
      <div className="app-body">
        <Sidebar runs={runs} activeId={activeId} viewId={view?.id ?? ""} />
        <div className="content">
          {active ? (
            <div className="run-bar">
              <ViewNav views={viewsFor(active)} runId={active.id} currentId={view?.id} />
              {/* A plain link to a file the server builds: no script, no Blob, no object URL. */}
              {active.state === "done" &&
              active.result &&
              (active.kind !== "ads" || active.hasReport) ? (
                <a
                  className="download"
                  href={reportPath(active.id)}
                  download="gaugeline-report.html"
                >
                  Download the report
                </a>
              ) : null}
            </div>
          ) : null}
          <main id="main">
            {active && view ? (
              <ViewPanel view={view} run={active} />
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
