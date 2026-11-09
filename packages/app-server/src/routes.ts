import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyError, parseCheckBody, readBody } from "./body.js";
import type { Runner } from "./runs.js";
import { StoreFull, type Run, type RunEvent, type Store } from "./store.js";

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const text = JSON.stringify(body);
  res
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(text)),
      "cache-control": "no-store",
      ...headers,
    })
    .end(text);
};
const notAllowed = (res: ServerResponse, allow: string) =>
  json(res, 405, { error: `Use ${allow} here.` }, { allow });

/** A run as the API shows it: no listeners, events only through /events. */
function view(r: Run, full: boolean) {
  return {
    id: r.id,
    url: r.url,
    state: r.state,
    startedAt: r.startedAt,
    ...(r.counts ? { counts: r.counts } : {}),
    ...(full && r.result ? { result: r.result } : {}),
    ...(full && r.checked ? { checked: r.checked } : {}),
    ...(full && r.reason ? { reason: r.reason } : {}),
  };
}

const line = (e: RunEvent) => `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
const final = (e: RunEvent) => e.event === "done" || e.event === "failed";

/** Server-Sent Events: every event after Last-Event-ID (or all), then live ones until the run ends. */
function stream(req: IncomingMessage, res: ServerResponse, r: Run) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const last = Number(req.headers["last-event-id"] ?? 0);
  for (const e of r.events) if (e.id > last) res.write(line(e));
  if (r.state !== "running") {
    res.end();
    return;
  }
  const listener = (e: RunEvent) => {
    res.write(line(e));
    if (final(e)) {
      r.listeners.delete(listener);
      res.end();
    }
  };
  r.listeners.add(listener);
  // The client went away mid-run: stop writing to it; the run carries on. (The response's close,
  // not the request's: a request with no body is "closed" as soon as it has been read.)
  res.on("close", () => r.listeners.delete(listener));
}

/** The four routes, behind the rules from G21 and G21a. False when the path isn't the API's. */
export async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: Store; runner: Runner },
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";
  if (path === "/api/check") {
    if (method !== "POST") return (notAllowed(res, "POST"), true);
    try {
      const { url } = parseCheckBody(req.headers["content-type"], await readBody(req));
      const { run } = ctx.runner.start(url);
      json(res, 202, { id: run.id });
    } catch (err) {
      if (err instanceof BodyError) {
        json(
          res,
          err.status,
          { error: err.message },
          err.status === 413 ? { connection: "close" } : {},
        );
        // Past the limit nothing more is read: the connection ends with the answer.
        if (err.status === 413) res.on("finish", () => req.socket.destroy());
      } else if (err instanceof StoreFull) json(res, 429, { error: err.message });
      else throw err;
    }
    return true;
  }
  if (path === "/api/runs") {
    if (method !== "GET") return (notAllowed(res, "GET"), true);
    json(
      res,
      200,
      ctx.store.list().map((r) => view(r, false)),
    );
    return true;
  }
  const m = /^\/api\/runs\/([^/]+)(\/events)?$/.exec(path);
  if (m) {
    if (method !== "GET") return (notAllowed(res, "GET"), true);
    const r = ctx.store.get(decodeURIComponent(m[1] ?? ""));
    if (!r)
      return (json(res, 404, { error: "There is no run with that id in this session." }), true);
    if (m[2]) stream(req, res, r);
    else json(res, 200, view(r, true));
    return true;
  }
  json(res, 404, { error: "There is no such API address." });
  return true;
}
