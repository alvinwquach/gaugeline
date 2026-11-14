import type { CatalogueItem, CatalogueVariant } from "./catalogue.js";
import { isConfigured } from "./env.js";
import { getJson, idText, isRecord, skuText, type JsonSource } from "./get-json.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector } from "./types.js";

/** A Square catalogue item. Its variations are the catalogue variants. */
export interface SquareItem extends CatalogueItem {
  source: "square";
}

export const SQUARE_ACCESS_TOKEN = "SQUARE_ACCESS_TOKEN";
/** Every variable the Square connector reads: what the CLI hands to core for it. */
export const SQUARE_ENV_VARS = [SQUARE_ACCESS_TOKEN] as const;

const LIST = "https://connect.squareup.com/v2/catalog/list?types=ITEM";
/** Proposed: pages read per run, so a runaway cursor can never keep a run going. */
export const SQUARE_MAX_PAGES = 50;

// ---- mapping ------------------------------------------------------------------------------------

/**
 * A variation's price. Square sends money as whole minor units already (`price_money.amount`, with
 * its currency), so nothing is converted. Variable pricing, a missing amount or one that is not a
 * non-negative whole number is null: no fixed price, not a free one. 0 is a free item.
 */
export function squarePrice(data: unknown): { price: number | null; currency: string } {
  const d = isRecord(data) ? data : {};
  const money = isRecord(d.price_money) ? d.price_money : {};
  const currency = typeof money.currency === "string" ? money.currency : "";
  const amount = money.amount;
  const fixed = d.pricing_type !== "VARIABLE_PRICING";
  const price =
    fixed && typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
      ? amount
      : null;
  return { price, currency };
}

/**
 * One entry of an item's `variations`. Availability is always null: Square keeps stock counts in
 * its Inventory API, which needs a second permission, and Gaugeline asks for the catalogue alone.
 */
export function mapSquareVariation(raw: unknown): CatalogueVariant {
  const id = isRecord(raw) ? idText(raw.id) : null;
  if (!isRecord(raw) || id === null)
    throw new Error("Square answered with a variation that has no id.");
  const data = isRecord(raw.item_variation_data) ? raw.item_variation_data : {};
  const sku = skuText(data.sku);
  return {
    id,
    ...(sku === undefined ? {} : { sku }),
    ...squarePrice(data),
    available: null,
  };
}

/**
 * One catalogue object as an item, or undefined when it is not an item (the list is asked for items
 * only, but a row of another type is skipped rather than guessed at). A deleted or archived item is
 * not active.
 */
export function mapSquareItem(raw: unknown): SquareItem | undefined {
  if (!isRecord(raw)) throw new Error("Square answered with something that is not an item.");
  if (raw.type !== "ITEM") return undefined;
  const id = idText(raw.id);
  if (id === null) throw new Error("Square answered with an item that has no id.");
  const data = isRecord(raw.item_data) ? raw.item_data : {};
  return {
    source: "square",
    id,
    name: typeof data.name === "string" ? data.name : "",
    active: raw.is_deleted !== true && data.is_archived !== true,
    variants: Array.isArray(data.variations)
      ? data.variations.map((v: unknown) => mapSquareVariation(v))
      : [],
  };
}

// ---- reading ------------------------------------------------------------------------------------

const refusal = (status: number): ConnectorRefusedError =>
  new ConnectorRefusedError(
    status,
    status === 401
      ? `Square did not accept ${SQUARE_ACCESS_TOKEN}: it is wrong, expired or revoked. Create a new access token.`
      : `${SQUARE_ACCESS_TOKEN} cannot read the item catalogue. Give the token the ITEMS_READ permission; nothing else is needed.`,
  );

export interface SquareConnectorOptions {
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Square as a source of items, variations and prices. Read only: GET the catalogue list for items,
 * following the cursor (at most SQUARE_MAX_PAGES pages), with the token in an Authorization header.
 * That is the only resource asked for, and the only permission it needs is ITEMS_READ.
 */
export function createSquareConnector(options: SquareConnectorOptions = {}): Connector<SquareItem> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "square",
    envVars: [...SQUARE_ENV_VARS],
    secretEnvVars: [SQUARE_ACCESS_TOKEN],
    configured: (env) => isConfigured(env, SQUARE_ENV_VARS),
    async read(env, fetcher, note = () => undefined) {
      try {
        const source: JsonSource = {
          fetcher,
          request: { authorization: `Bearer ${(env[SQUARE_ACCESS_TOKEN] ?? "").trim()}` },
          sleep,
          system: "Square",
        };
        // A Map keyed by id: list order is kept, and an item repeated across pages is kept once.
        const byId = new Map<string, SquareItem>();
        let cursor: string | undefined;
        for (let page = 1; page <= SQUARE_MAX_PAGES; page++) {
          const url = `${LIST}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
          let body: unknown;
          try {
            body = (await getJson(source, url)).body;
          } catch (err) {
            if (err instanceof ConnectorRefusedError) throw refusal(err.status);
            throw err;
          }
          if (!isRecord(body) || (body.objects !== undefined && !Array.isArray(body.objects)))
            throw new Error("Square answered with something that is not a catalogue.");
          for (const raw of (body.objects as unknown[] | undefined) ?? []) {
            const item = mapSquareItem(raw);
            if (item !== undefined && !byId.has(item.id)) byId.set(item.id, item);
          }
          const next =
            typeof body.cursor === "string" && body.cursor !== "" ? body.cursor : undefined;
          if (next === undefined) return [...byId.values()];
          if (next === cursor) {
            note(
              `Square sent the same page of items twice, so Gaugeline stopped reading them after ${byId.size}.`,
            );
            return [...byId.values()];
          }
          cursor = next;
        }
        note(
          `Square has more items than Gaugeline reads in one run: it read the first ${byId.size} (${SQUARE_MAX_PAGES} pages) and left the rest out.`,
        );
        return [...byId.values()];
      } catch (err) {
        if (err instanceof ConnectorRefusedError || err instanceof ConnectorRateLimitedError)
          throw err;
        // Whatever a fetcher put in a message, the token is blanked before it leaves this file.
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [SQUARE_ACCESS_TOKEN])(text));
      }
    },
  };
}

/** The default connector. */
export const squareConnector: Connector<SquareItem> = createSquareConnector();
