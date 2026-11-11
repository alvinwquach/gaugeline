import { Readable } from "node:stream";
import type { ExportLister, RawExportFile } from "@gaugeline/core";
import type { Transport } from "../../../../core/src/fetcher.js";
import {
  REF,
  SUPABASE_TOKEN,
  SUPABASE_URL,
  supabaseOn,
} from "../../../../core/src/backups/__tests__/world.js";

export {
  NOW,
  REF,
  SUPABASE_TOKEN,
  SUPABASE_URL,
} from "../../../../core/src/backups/__tests__/world.js";

/** gaugeline.backups.json for Marlowe Bar, an invented bar: bookings in Supabase, a nightly dump of the menu data. */
export const BAR_CONFIG = {
  supabase: { projectRef: REF },
  exports: [{ name: "menu", folder: "backups/menu" }],
};

export const BAR_ENV = { NO_COLOR: "1", SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN };

const file = (name: string, size: number, modified: string): RawExportFile => ({
  name,
  size,
  modified,
});

/** The menu export folder: the last file is far smaller than the one before it. */
export const MENU_FILES: RawExportFile[] = [
  file("menu-2026-11-08.json.gz", 95_000, "2026-11-08T03:00:12Z"),
  file("menu-2026-11-09.json.gz", 94_000, "2026-11-09T03:00:09Z"),
  file("menu-2026-11-10.json.gz", 12_000, "2026-11-10T03:00:31Z"),
];

export const barLister: ExportLister = (folder) =>
  folder === "backups/menu"
    ? Promise.resolve(MENU_FILES)
    : Promise.reject(new Error(`ENOENT: no such file or directory, scandir '${folder}'`));

const HTML = (title: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1><p>Open Tuesday to Sunday.</p></body></html>`;

/**
 * Marlowe Bar (daily backups on, the newest 12 days old) and Ember Pop-up Kitchen (a Wix site, nothing to
 * read), answered from recorded responses; nothing touches a network.
 */
export function backupsWorld(over: { supabase?: { status: number; body?: unknown } } = {}) {
  const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const supabase = over.supabase ?? {
    status: 200,
    body: supabaseOn("2026-10-30T03:00:00Z", {
      backups: [{ status: "COMPLETED", inserted_at: "2026-10-30T03:00:00Z" }],
    }),
  };
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const answer = (status: number, headers: Record<string, string>, body: string) =>
      Promise.resolve({
        status,
        headers,
        body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from(body)]),
      });
    if (url.href === SUPABASE_URL)
      return answer(
        supabase.status,
        { "content-type": "application/json" },
        JSON.stringify(supabase.body ?? {}),
      );
    if (url.hostname === "marlowe-bar.example" && url.pathname === "/")
      return answer(200, { "content-type": "text/html; charset=utf-8" }, HTML("Marlowe Bar"));
    if (url.hostname === "ember-popup.example" && url.pathname === "/")
      return answer(
        200,
        { "content-type": "text/html; charset=utf-8", "x-wix-request-id": "1699-ember" },
        HTML("Ember Pop-up Kitchen", '<meta name="generator" content="Wix.com Website Builder">'),
      );
    return answer(404, { "content-type": "text/plain" }, "not found");
  };
  return { transport, seen };
}
