import type { Fetcher } from "../fetcher.js";
import { inKind } from "../request-log.js";
import type { TrackersConfig } from "./config.js";
import { findTrackersInContainer, type Tracker } from "./fingerprints.js";

/** At most this many containers are read for one page. */
export const CONTAINER_CAP = 3;

/** A Tag Manager container's public file: its trackers, or why it could not be read. */
export type ContainerRead =
  | { ok: true; id: string; trackers: Tracker[]; truncated: boolean }
  | { ok: false; id: string; reason: string };

/**
 * What the tracker checks read, once each and shared: the public JavaScript file of each Google Tag Manager
 * container a page loads. It is a plain GET of www.googletagmanager.com/gtm.js?id=GTM-XXXX through the
 * fetcher, the file the page's own visitors receive; the container is read as text and never run. Tags a
 * container loads from a template that keeps its id out of the file are not seen.
 */
export interface Trackers {
  readonly config: TrackersConfig;
  container(id: string): Promise<ContainerRead>;
}

/** The address of a container's public file. The id was matched as GTM- and capitals and digits only. */
export const containerUrl = (id: string): string =>
  `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;

export function createTrackers(config: TrackersConfig, fetcher: Fetcher): Trackers {
  const reads = new Map<string, Promise<ContainerRead>>();
  const read = async (id: string): Promise<ContainerRead> => {
    try {
      const last = (await inKind("script", () => fetcher.get(containerUrl(id)))).at(-1);
      if (!last) return { ok: false, id, reason: `${id} gave no answer.` };
      if (last.status < 200 || last.status >= 300)
        return { ok: false, id, reason: `${id} answered ${last.status}.` };
      return {
        ok: true,
        id,
        trackers: findTrackersInContainer(last.body ?? ""),
        truncated: last.truncated === true,
      };
    } catch (err) {
      return {
        ok: false,
        id,
        reason: `${id} could not be read: ${err instanceof Error ? err.message : "the request failed"}.`,
      };
    }
  };
  return {
    config,
    container(id) {
      let p = reads.get(id);
      if (!p) reads.set(id, (p = read(id)));
      return p;
    },
  };
}
