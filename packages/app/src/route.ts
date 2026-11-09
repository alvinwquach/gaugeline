import { useCallback, useSyncExternalStore } from "react";

/** The page's address is #/<runId>/<viewId>, so the server needs no route of its own for either. */
export interface Route {
  runId: string | null;
  viewId: string | null;
}

export function parseHash(hash: string): Route {
  const m = /^#\/([^/]*)(?:\/([^/]*))?\/?$/.exec(hash);
  const decode = (v: string | undefined): string | null => {
    if (!v) return null;
    try {
      return decodeURIComponent(v);
    } catch {
      return null;
    }
  };
  return { runId: decode(m?.[1]), viewId: decode(m?.[2]) };
}

export function formatHash(runId: string, viewId: string): string {
  return `#/${encodeURIComponent(runId)}/${encodeURIComponent(viewId)}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The route in the address bar. Re-renders when it changes (a click, the back button, a typed address). */
export function useRoute(): Route & {
  go: (runId: string, viewId: string, replace?: boolean) => void;
} {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  const go = useCallback((runId: string, viewId: string, replace = false) => {
    const next = formatHash(runId, viewId);
    if (window.location.hash === next) return;
    if (replace) {
      // replaceState doesn't fire hashchange: tell the page by hand so every reader sees it.
      window.history.replaceState(null, "", next);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else window.location.hash = next;
  }, []);
  return { ...parseHash(hash), go };
}
