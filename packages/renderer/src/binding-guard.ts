/**
 * Every function a page can call by name (the form counter, the observer's capture of a push) is reachable from
 * any script on the page, through Playwright's own controller as well as `window`: a page can call one 400,000
 * times in a loop. Each call costs the browser driver memory and time before any handler of ours runs, so the only
 * bound that holds is to stop the page: past the cap a call does nothing (it does not read its arguments), is
 * counted by one integer, and tells the session once, which marks the page as having tampered and closes it.
 * No array, no log, no per-call state: O(1) memory however many calls come.
 */
export const BINDING_CALL_CAP = 1000;

export function budgeted<A extends unknown[]>(
  fn: (...args: A) => void,
  onFlood: () => void,
  cap: number = BINDING_CALL_CAP,
): (...args: A) => void {
  let calls = 0;
  return (...args: A): void => {
    if (calls >= cap) {
      if (calls === cap) {
        calls += 1;
        onFlood();
      }
      return;
    }
    calls += 1;
    fn(...args);
  };
}

/** What a load says when the page was stopped for it: never a pass, never a finding. */
export const FLOOD_REASON =
  "the page called the functions Gaugeline gives its scripts more times than a real page does, so it was stopped and what it reported is not trusted";
