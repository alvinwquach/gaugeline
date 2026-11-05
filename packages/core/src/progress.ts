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
