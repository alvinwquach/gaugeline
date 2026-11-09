import type { RunState } from "../store";

/**
 * What a view says until the run has something to show: still checking, could not run, or the result
 * not read yet. Null once the run is done and its result is here.
 */
export function RunNotice({ run, what }: { run: RunState; what: string }) {
  if (run.state === "running")
    return (
      <p className="notice">This page is still checking. {what} appears here when it is done.</p>
    );
  if (run.state === "failed")
    return <p className="notice">{run.reason ?? run.loadError ?? "This check could not run."}</p>;
  if (run.loadError) return <p className="notice">{run.loadError}</p>;
  if (!run.result && !run.checked) return <p className="notice">Loading the results...</p>;
  return null;
}
