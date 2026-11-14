/**
 * What a run is doing, as typed events. Core only emits these; each caller (CLI, app, MCP server)
 * decides how, and whether, to show them. No I/O here.
 */
export type ProgressEvent =
  | { step: "load-page" }
  | { step: "robots-sitemap" }
  | { step: "links"; count: number }
  | { step: "scripts" }
  | { step: "debug"; message: string }
  | { step: "warn"; message: string };

export type ProgressSink = (event: ProgressEvent) => void;

/** One request, reported by the fetcher for debug output. Never carries headers or bodies. */
export interface RequestInfo {
  method: string;
  url: string;
  status: number | "error";
  ms: number;
}

/** What a step says, in the words the terminal prints (the app's progress uses the same). */
export function progressText(e: ProgressEvent): string | undefined {
  switch (e.step) {
    case "load-page":
      return "Loading the page without JavaScript";
    case "robots-sitemap":
      return "Reading robots.txt and the sitemap";
    case "links":
      if (e.count === 0) return undefined;
      return `Checking ${e.count === 1 ? "1 link" : `${e.count} links`} on the page`;
    case "scripts":
      return "Scanning the site's JavaScript for leaked keys";
    case "debug":
    case "warn":
      return undefined;
    default: {
      const never: never = e;
      return never;
    }
  }
}
