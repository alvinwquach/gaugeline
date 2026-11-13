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

/** Throws ReceiptsExportRefused unless the signed-in person is an owner or admin of `orgId`. */
async function assertCanExport(tx: Tx, orgId: string): Promise<void> {
  const allowed = await tx`select exists (
      select 1 from private.admin_org_ids() a where a = ${orgId}::uuid) as ok`;
  if (allowed[0]?.ok !== true) throw new ReceiptsExportRefused();
}

/** The chain of `orgId`, one canonical receipt per line in chain order, as the database stored it. */
export async function exportReceipts(tx: Tx, orgId: string): Promise<string> {
  await assertCanExport(tx, orgId);
  const rows = await tx`select record from public.receipts where org_id = ${orgId} order by seq`;
  return rows.map((r) => `${r.record as string}\n`).join("");
}

/**
 * Who wrote each receipt's decision, one JSON line per receipt in chain order: {"seq":1,"writtenBy":"person"}.
 * Not part of the chain (the hashed format is fixed): "person" when the signed-in person recorded their own
 * choice, "service" when the server or the chat approval function wrote it in someone's name.
 */
export async function exportReceiptWriters(tx: Tx, orgId: string): Promise<string> {
  await assertCanExport(tx, orgId);
  const rows =
    await tx`select seq, written_by from public.receipts where org_id = ${orgId} order by seq`;
  return rows
    .map((r) => `${JSON.stringify({ seq: Number(r.seq), writtenBy: r.written_by as string })}\n`)
    .join("");
}

function download(
  request: Request,
  deps: WebDeps,
  read: (tx: Tx, orgId: string) => Promise<string>,
  filename: string,
): Promise<Response> {
  return signedIn(request, deps, async ({ tx, shell }) => {
    if (!shell) return redirect("/");
    let body: string;
    try {
      body = await read(tx, shell.current.orgId);
    } catch (e) {
      if (e instanceof ReceiptsExportRefused)
        return respondText(403, `${e.message}.\n`, "text/plain; charset=utf-8");
      throw e;
    }
    const res = respondText(200, body, "application/x-ndjson; charset=utf-8");
    res.headers.set("content-disposition", `attachment; filename="${filename}"`);
    res.headers.set("cache-control", "no-store");
    return res;
  });
}

/** GET /receipts: the current organisation's chain as a download, for owners and admins only. */
export const receiptsDownload = (request: Request, deps: WebDeps): Promise<Response> =>
  download(request, deps, exportReceipts, "receipts.jsonl");

/** GET /receipts/writers: who wrote each receipt's decision, beside the chain. Owners and admins only. */
export const receiptWritersDownload = (request: Request, deps: WebDeps): Promise<Response> =>
  download(request, deps, exportReceiptWriters, "receipt-writers.jsonl");
