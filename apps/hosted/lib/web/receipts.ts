/**
 * The approval receipts export (AG-06): an organisation's receipt chain as JSON lines, for its owners and
 * admins to download and check offline with `gaugeline receipts verify`. Read as the signed-in person, so
 * row-level security applies; the role is also checked first, because a member would otherwise get an
 * empty file that verifies as an empty chain.
 */
import { signedIn } from "./handlers.js";
import type { WebDeps } from "./deps.js";
import type { Tx } from "./db.js";
import { redirect, respondText } from "./layout.js";

export class ReceiptsExportRefused extends Error {
  constructor() {
    super("only an owner or admin of the organisation can export its receipts");
    this.name = "ReceiptsExportRefused";
  }
}

/** The chain of `orgId`, one canonical receipt per line in chain order, as the database stored it. */
export async function exportReceipts(tx: Tx, orgId: string): Promise<string> {
  const allowed = await tx`select exists (
      select 1 from private.admin_org_ids() a where a = ${orgId}::uuid) as ok`;
  if (allowed[0]?.ok !== true) throw new ReceiptsExportRefused();
  const rows = await tx`select record from public.receipts where org_id = ${orgId} order by seq`;
  return rows.map((r) => `${r.record as string}\n`).join("");
}

/** GET /receipts: the current organisation's chain as a download, for owners and admins only. */
export function receiptsDownload(request: Request, deps: WebDeps): Promise<Response> {
  return signedIn(request, deps, async ({ tx, shell }) => {
    if (!shell) return redirect("/");
    let body: string;
    try {
      body = await exportReceipts(tx, shell.current.orgId);
    } catch (e) {
      if (e instanceof ReceiptsExportRefused)
        return respondText(403, `${e.message}.\n`, "text/plain; charset=utf-8");
      throw e;
    }
    const res = respondText(200, body, "application/x-ndjson; charset=utf-8");
    res.headers.set("content-disposition", 'attachment; filename="receipts.jsonl"');
    res.headers.set("cache-control", "no-store");
    return res;
  });
}
